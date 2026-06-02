"""Unified text-conditioned trainer. One CLI, every supported robot.

Loads the robot via the profile registry, instantiates the profile-driven
MuJoCo env, and trains a text-conditioned policy. The default backend is the
Alberta streaming continual-learning controller; PPO remains available as an
explicit CPU smoke baseline.

Run::
    uv run python scripts/train_text_conditioned.py --profile unitree-g1 --steps 30000
    uv run python scripts/train_text_conditioned.py --profile unitree-g1 --backend ppo --steps 30000
    uv run python scripts/train_text_conditioned.py --profile hiwonder-ainex --dry-run

The full Brax-MJX recipe still lives in
`eliza_robot/sim/mujoco/asimov_mjx_training.py` for the asimov-1 +
Nebius GPU path. This CLI is the default continual-learning path for profile
driven robot policies and the CPU smoke entrypoint before committing GPU spend.
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


def _train_alberta(
    profile_id: str,
    out_dir: Path,
    *,
    total_steps: int,
    seed: int,
    include_tasks: tuple[str, ...],
    pca_dim: int,
    episode_steps: int,
    eval_episodes: int,
    domain_rand: bool,
    action_scale: float = 0.3,
    action_scale_initial: float | None = None,
    action_scale_increment: float = 0.05,
    locomotion_action_prior: str = "none",
    locomotion_prior_residual_scale: float = 1.0,
    locomotion_prior_residual_scale_initial: float | None = None,
    locomotion_prior_residual_scale_increment: float = 0.05,
    locomotion_prior_residual_mode: str = "joint",
    locomotion_prior_feedback_pitch: float | None = None,
    locomotion_prior_feedback_roll: float | None = None,
    locomotion_prior_feedback_yaw: float | None = None,
) -> dict:
    from eliza_robot.rl.alberta.train_robot import (
        steps_per_task_from_total,
        train_robot,
    )

    steps_per_task = steps_per_task_from_total(total_steps, len(include_tasks))

    return train_robot(
        profile_id,
        list(include_tasks),
        steps_per_task,
        out_dir,
        pca_dim=pca_dim,
        episode_steps=episode_steps,
        action_scale=action_scale,
        action_scale_initial=action_scale_initial,
        action_scale_increment=action_scale_increment,
        eval_episodes=eval_episodes,
        seed=seed,
        requested_total_steps=total_steps,
        domain_rand=domain_rand,
        locomotion_action_prior=locomotion_action_prior,
        locomotion_prior_residual_scale=locomotion_prior_residual_scale,
        locomotion_prior_residual_scale_initial=locomotion_prior_residual_scale_initial,
        locomotion_prior_residual_scale_increment=(
            locomotion_prior_residual_scale_increment
        ),
        locomotion_prior_residual_mode=locomotion_prior_residual_mode,
        locomotion_prior_feedback_pitch=locomotion_prior_feedback_pitch,
        locomotion_prior_feedback_roll=locomotion_prior_feedback_roll,
        locomotion_prior_feedback_yaw=locomotion_prior_feedback_yaw,
    )


def _train_ppo(
    profile_id: str,
    out_dir: Path,
    *,
    total_steps: int,
    seed: int,
    include_tasks: tuple[str, ...],
    pca_dim: int,
    domain_rand: bool,
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
                domain_rand=domain_rand,
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
        f"[unified-train:ppo] {profile_id}: tasks={len(include_tasks)} "
        f"obs={vec_env.observation_space.shape} act={vec_env.action_space.shape} "
        f"target={total_steps} steps",
        file=sys.stderr,
    )
    t0 = time.time()
    model.learn(total_timesteps=total_steps, progress_bar=False)
    wall_s = time.time() - t0
    actual_steps = int(model.num_timesteps)
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
        "output_dim": len(profile.kinematics.joints),
        "proprio_dim": proprio_dim,
        "text_dim": pca_dim,
        "pca_dim": pca_dim,
        "requested_total_steps": int(total_steps),
        "total_steps": actual_steps,
        "domain_rand": bool(domain_rand),
        "wall_clock_s": round(wall_s, 2),
        "seed": int(seed),
        "ckpt": ckpt_path.name,
        "encoder_model": "sentence-transformers/all-MiniLM-L6-v2",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"[unified-train:ppo] saved {ckpt_path.name} + manifest.json in {wall_s:.1f}s",
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
        "output_dim": len(env.profile.kinematics.joints),
        "default_backend": "alberta",
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
        help="Output directory. Default: checkpoints/text_conditioned_<profile>_<backend>/",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=30_000,
        help=(
            "Total env-step budget. For Alberta continual learning this is "
            "split evenly across tasks; use eliza-robot-train-alberta "
            "--steps-per-task for explicit per-phase budgets."
        ),
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--pca-dim", type=int, default=32)
    parser.add_argument("--episode-steps", type=int, default=200)
    parser.add_argument("--action-scale", type=float, default=0.3)
    parser.add_argument("--action-scale-initial", type=float, default=None)
    parser.add_argument("--action-scale-increment", type=float, default=0.05)
    parser.add_argument("--eval-episodes", type=int, default=3)
    parser.add_argument(
        "--locomotion-action-prior",
        choices=(
            "none",
            "gait",
            "hiwonder_sine",
            "hiwonder_contact_sine",
            "hiwonder_low_slip_contact_sine",
        ),
        default="none",
    )
    parser.add_argument("--locomotion-prior-residual-scale", type=float, default=1.0)
    parser.add_argument("--locomotion-prior-residual-scale-initial", type=float, default=None)
    parser.add_argument(
        "--locomotion-prior-residual-scale-increment",
        type=float,
        default=0.05,
    )
    parser.add_argument(
        "--locomotion-prior-residual-mode",
        choices=("joint", "hiwonder_stride_mod"),
        default="joint",
    )
    parser.add_argument("--locomotion-prior-feedback-pitch", type=float, default=None)
    parser.add_argument("--locomotion-prior-feedback-roll", type=float, default=None)
    parser.add_argument("--locomotion-prior-feedback-yaw", type=float, default=None)
    parser.add_argument(
        "--backend",
        choices=("alberta", "ppo"),
        default="alberta",
        help="Training backend. Alberta streaming continual learning is the default; PPO is a smoke baseline.",
    )
    parser.add_argument(
        "--tasks",
        nargs="+",
        default=list(_DEFAULT_TASKS),
        help="Curriculum tasks to train on.",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--no-domain-rand",
        action="store_true",
        help="disable MuJoCo domain randomization for training envs",
    )
    args = parser.parse_args(argv)

    out_dir = args.out or (
        PKG_ROOT / "checkpoints" / f"text_conditioned_{args.profile}_{args.backend}"
    )
    tasks = tuple(args.tasks)

    if args.dry_run:
        manifest = _dry_run(args.profile, out_dir, seed=args.seed)
    elif args.backend == "alberta":
        manifest = _train_alberta(
            args.profile,
            out_dir,
            total_steps=args.steps,
            seed=args.seed,
            include_tasks=tasks,
            pca_dim=args.pca_dim,
            episode_steps=args.episode_steps,
            action_scale=args.action_scale,
            action_scale_initial=args.action_scale_initial,
            action_scale_increment=args.action_scale_increment,
            eval_episodes=args.eval_episodes,
            domain_rand=not args.no_domain_rand,
            locomotion_action_prior=args.locomotion_action_prior,
            locomotion_prior_residual_scale=args.locomotion_prior_residual_scale,
            locomotion_prior_residual_scale_initial=(
                args.locomotion_prior_residual_scale_initial
            ),
            locomotion_prior_residual_scale_increment=(
                args.locomotion_prior_residual_scale_increment
            ),
            locomotion_prior_residual_mode=args.locomotion_prior_residual_mode,
            locomotion_prior_feedback_pitch=args.locomotion_prior_feedback_pitch,
            locomotion_prior_feedback_roll=args.locomotion_prior_feedback_roll,
            locomotion_prior_feedback_yaw=args.locomotion_prior_feedback_yaw,
        )
    else:
        manifest = _train_ppo(
            args.profile,
            out_dir,
            total_steps=args.steps,
            seed=args.seed,
            include_tasks=tasks,
            pca_dim=args.pca_dim,
            domain_rand=not args.no_domain_rand,
        )
    print(json.dumps({"out_dir": str(out_dir), "manifest": manifest}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
