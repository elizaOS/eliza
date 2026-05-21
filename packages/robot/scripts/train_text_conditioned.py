"""Unified text-conditioned PPO trainer. One CLI, every supported robot.

Replaces the per-profile dispatch in
`eliza_robot/rl/text_conditioned/train.py` with a single entrypoint that
loads the robot via the profile registry, instantiates the profile-driven
env, and runs stable-baselines3 PPO on CPU.

Run::
    uv run python scripts/train_text_conditioned.py --profile unitree-g1 --steps 30000
    uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --dry-run

The full Brax-MJX recipe still lives in
`eliza_robot/sim/mujoco/asimov_mjx_training.py` for the asimov-1 +
Nebius GPU path; this CLI is the CPU smoke entrypoint that proves the
unified pipeline before committing GPU spend.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

os.environ.setdefault("JAX_PLATFORMS", "cpu")

from eliza_robot.profiles.schema import list_profiles, load_profile  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)

_DEFAULT_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _train(
    profile_id: str,
    out_dir: Path,
    *,
    total_steps: int,
    seed: int,
    include_tasks: tuple[str, ...],
    pca_dim: int,
) -> dict:
    from stable_baselines3 import PPO
    from stable_baselines3.common.monitor import Monitor
    from stable_baselines3.common.vec_env import DummyVecEnv

    out_dir.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    from eliza_robot.curriculum.loader import load_curriculum

    curriculum = load_curriculum()

    def _make():
        env = make_text_conditioned_env(
            profile_id,
            config=ProfileEnvConfig(
                include_tasks=include_tasks,
                exclude_tasks=(),
                pca_dim=pca_dim,
                episode_steps=200,
            ),
        )
        return Monitor(env)

    vec_env = DummyVecEnv([_make])
    model = PPO(
        "MlpPolicy",
        vec_env,
        n_steps=256,
        batch_size=64,
        n_epochs=4,
        learning_rate=3e-4,
        gamma=0.97,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.005,
        vf_coef=0.5,
        policy_kwargs=dict(net_arch=dict(pi=[128, 128], vf=[128, 128])),
        seed=seed,
        device="cpu",
        verbose=1,
    )
    print(
        f"[unified-train] {profile_id}: tasks={len(include_tasks)} "
        f"obs={vec_env.observation_space.shape} act={vec_env.action_space.shape} "
        f"target={total_steps} steps",
        file=sys.stderr,
    )
    t0 = time.time()
    model.learn(total_timesteps=total_steps, progress_bar=False)
    wall_s = time.time() - t0
    ckpt_path = out_dir / "policy.zip"
    model.save(str(ckpt_path))
    obs_dim = int(vec_env.observation_space.shape[0])
    action_dim = int(vec_env.action_space.shape[0])
    proprio_dim = obs_dim - pca_dim
    manifest = {
        "regime": "smoke_sb3_ppo",
        "profile_id": profile_id,
        "profile_version": profile.version,
        "curriculum_version": curriculum.version,
        "active_tasks": list(include_tasks),
        "obs_dim": obs_dim,
        "action_dim": action_dim,
        "output_dim": action_dim,
        "proprio_dim": proprio_dim,
        "text_dim": pca_dim,
        "pca_dim": pca_dim,
        "total_steps": int(total_steps),
        "wall_clock_s": round(wall_s, 2),
        "seed": int(seed),
        "ckpt": ckpt_path.name,
        "encoder_model": "sentence-transformers/all-MiniLM-L6-v2",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"[unified-train] saved {ckpt_path.name} + manifest.json in {wall_s:.1f}s",
        file=sys.stderr,
    )
    return manifest


def _dry_run(profile_id: str, out_dir: Path, *, seed: int) -> dict:
    import numpy as np

    out_dir.mkdir(parents=True, exist_ok=True)
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",), exclude_tasks=(), episode_steps=4
        ),
    )
    obs, _ = env.reset(seed=seed)
    out = env.step(np.zeros(env.action_space.shape, dtype=np.float32))
    manifest = {
        "regime": "dry_run",
        "profile_id": profile_id,
        "obs_dim": int(env.observation_space.shape[0]),
        "action_dim": int(env.action_space.shape[0]),
        "reset_obs_shape": list(obs.shape),
        "step_reward": float(out[1]),
        "step_terminated": bool(out[2]),
        "seed": int(seed),
        "dry_run": True,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        choices=list_profiles(),
        required=True,
        help="Robot profile id (one of the 4 supported).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory. Default: checkpoints/text_conditioned_<profile>_smoke/",
    )
    parser.add_argument("--steps", type=int, default=30_000)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--pca-dim", type=int, default=32)
    parser.add_argument(
        "--tasks",
        nargs="+",
        default=list(_DEFAULT_TASKS),
        help="Curriculum tasks to train on.",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    out_dir = args.out or (
        PKG_ROOT / "checkpoints" / f"text_conditioned_{args.profile}_smoke"
    )
    tasks = tuple(args.tasks)

    if args.dry_run:
        manifest = _dry_run(args.profile, out_dir, seed=args.seed)
    else:
        manifest = _train(
            args.profile,
            out_dir,
            total_steps=args.steps,
            seed=args.seed,
            include_tasks=tasks,
            pca_dim=args.pca_dim,
        )
    print(json.dumps({"out_dir": str(out_dir), "manifest": manifest}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
