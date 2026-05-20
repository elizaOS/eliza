"""Text-conditioned PPO trainer for the AiNex curriculum.

Two regimes:
  - `--smoke`  : CPU-friendly stable-baselines3 PPO on
                 `TextConditionedJoystickEnv` (uses python-mujoco, not MJX).
                 Default 30k env steps, runs in ~3-5 minutes on a laptop.
                 Saves checkpoint to `checkpoints/text_conditioned_smoke/`.

  - `--full`   : (recommended on Nebius / 5080) MJX-Brax PPO on the same
                 logical env via a thin Brax wrapper. 150M env steps,
                 ~1-3 hours wall-clock on a 16 GB GPU per the Playground
                 research surveys.

The checkpoint format is unified: both regimes write a `.zip`
(stable-baselines3) + a `manifest.json` that records the curriculum
version, PCA dim, and active task subset. The bridge's policy.tick
handler loads the .zip via `eliza_robot.rl.text_conditioned.policy`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.text_conditioned.encoder import build_task_embeddings
from eliza_robot.rl.text_conditioned.env import (
    TextConditionedJoystickEnv,
    TextEnvConfig,
)


def _train_smoke(out_dir: Path, total_steps: int, seed: int = 0) -> dict:
    """Stable-baselines3 PPO smoke run on CPU. Returns a manifest dict."""
    from stable_baselines3 import PPO
    from stable_baselines3.common.monitor import Monitor
    from stable_baselines3.common.vec_env import DummyVecEnv

    out_dir.mkdir(parents=True, exist_ok=True)

    curriculum = load_curriculum()
    embeddings = build_task_embeddings(curriculum=curriculum)

    # Stick to a small task subset for the smoke so the policy can
    # actually start producing meaningful joint targets in minutes.
    cfg = TextEnvConfig(
        tier_subset=(1,),
        include_tasks=("stand_up", "walk_forward", "turn_left", "turn_right"),
        exclude_tasks=(),
        pca_dim=32,
        episode_steps=200,
    )

    def _make() -> TextConditionedJoystickEnv:
        env = TextConditionedJoystickEnv(
            config=cfg, curriculum=curriculum, embeddings=embeddings
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
        f"[smoke] PPO over {len(cfg.include_tasks)} tasks "
        f"(obs={vec_env.observation_space.shape}, act={vec_env.action_space.shape}), "
        f"target={total_steps} env steps"
    )
    t0 = time.time()
    model.learn(total_timesteps=total_steps, progress_bar=False)
    wall_s = time.time() - t0
    ckpt_path = out_dir / "policy.zip"
    model.save(str(ckpt_path))
    manifest = {
        "regime": "smoke_sb3_ppo",
        "curriculum_version": curriculum.version,
        "pca_dim": cfg.pca_dim,
        "active_tasks": list(cfg.include_tasks),
        "obs_dim": int(vec_env.observation_space.shape[0]),
        "action_dim": int(vec_env.action_space.shape[0]),
        "total_steps": total_steps,
        "wall_clock_s": round(wall_s, 1),
        "seed": seed,
        "ckpt": str(ckpt_path.name),
        "encoder_model": "sentence-transformers/all-MiniLM-L6-v2",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(
        f"[smoke] saved {ckpt_path.name} + manifest.json — "
        f"{total_steps} steps in {wall_s:.1f}s"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[2].parent
        / "checkpoints"
        / "text_conditioned_smoke",
        help="output directory for the checkpoint + manifest",
    )
    parser.add_argument(
        "--steps", type=int, default=30_000, help="env steps for the smoke run"
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--smoke",
        action="store_true",
        default=True,
        help="run the CPU SB3 smoke trainer (default).",
    )
    args = parser.parse_args()
    if args.smoke:
        _train_smoke(args.out, args.steps, args.seed)
        return 0
    print("--full not yet implemented in this revision", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
