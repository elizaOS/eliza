"""Train a ROBUST omnidirectional, stand-capable Unitree H1 walking policy.

This is the research-informed refinement of the proven H1JoystickGaitTracking
recipe. The stock env walks forward/backward/strafe well but (empirically):
  - drifts backward on a ZERO command (never learns to truly stand), and
  - turns weakly (tracking_ang_vel weight is only 0.75 vs tracking_lin_vel 3.5).

Root causes (from the env's default_config + a 2026-05-28 SOTA review):
  - sample_command only zeros PER-AXIS via a 0.1 threshold, so a *full*
    stand-still command (all three axes zero) is sampled ~0.1^3 of the time —
    the policy barely sees "stand still". Berkeley-Humanoid-Lite (rel_standing
    _envs) and Seo et al. 2025 zero the WHOLE command 2-20% of episodes.
  - yaw tracking is under-weighted.

Targeted, low-risk fixes (NOT the foot_slip-style overrides that trapped
learning at reward ~5): full-command-zeroing `--stand-prob` of episodes, and a
moderate `tracking_ang_vel` boost. Everything else stays at the proven default
recipe that already walks. Train on GPU (ELIZA_ROBOT_USE_GPU=1, ~8192 envs).

Usage::

    ELIZA_ROBOT_USE_GPU=1 uv run python scripts/train_omni_h1.py \
        --num-timesteps 150000000 --num-envs 8192 --out /tmp/robotwalk/h1_omni
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import time
from pathlib import Path

import numpy as np


def _resolve_jax_platform() -> None:
    if os.environ.get("ELIZA_ROBOT_USE_GPU", os.environ.get("MILADY_ROBOT_USE_GPU")) != "1":
        os.environ.setdefault("JAX_PLATFORMS", "cpu")
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")


def make_omni_h1(stand_prob: float, tracking_ang_vel: float, impl: str = "jax"):
    """H1JoystickGaitTracking + full-command-zeroing + stronger yaw tracking."""
    import jax
    import jax.numpy as jp
    from mujoco_playground._src.locomotion.h1.joystick_gait_tracking import (
        JoystickGaitTracking,
        default_config,
    )

    class OmniH1(JoystickGaitTracking):
        _stand_prob = float(stand_prob)

        def sample_command(self, rng: jax.Array) -> jax.Array:
            rng, zrng = jax.random.split(rng)
            cmd = super().sample_command(rng)
            # Full stand-still command (all axes zero) with prob _stand_prob so
            # the policy explicitly learns to hold position on a zero command.
            stand = jax.random.uniform(zrng) < self._stand_prob
            return jp.where(stand, jp.zeros_like(cmd), cmd)

    cfg = default_config()
    cfg.impl = impl
    # Moderate yaw-tracking boost (default 0.75 is too low for crisp turns).
    cfg.reward_config.scales.tracking_ang_vel = float(tracking_ang_vel)
    return OmniH1(config=cfg)


def train(args) -> Path:
    import jax
    from brax.io import model as brax_model
    from brax.training.acme import running_statistics  # noqa: F401  (warm import)
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.training.agents.ppo import train as ppo_train_module
    from mujoco_playground.config import locomotion_params

    try:
        from mujoco_playground import wrapper as mjx_wrapper

        wrap_fn = mjx_wrapper.wrap_for_brax_training
    except Exception:  # pragma: no cover
        from mujoco_playground._src.wrapper import wrap_for_brax_training as wrap_fn

    env = make_omni_h1(args.stand_prob, args.tracking_ang_vel)
    cfg = dict(locomotion_params.brax_ppo_config("H1JoystickGaitTracking"))
    nf = cfg.get("network_factory", {})
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"JAX backend: {jax.default_backend()} devices={jax.devices()}", flush=True)
    print(f"OmniH1: action={env.action_size} obs={env.observation_size} dt={env.dt} "
          f"stand_prob={args.stand_prob} tracking_ang_vel={args.tracking_ang_vel}", flush=True)
    print(f"PPO: timesteps={args.num_timesteps:,} num_envs={args.num_envs}", flush=True)

    metrics_log: list[dict] = []
    best = float("-inf")
    start = time.time()

    def progress(num_steps, metrics):
        nonlocal best
        r = float(metrics.get("eval/episode_reward", metrics.get("eval/episode_reward_mean", 0.0)))
        el = time.time() - start
        metrics_log.append({"steps": int(num_steps), "reward": r, "elapsed": el,
                            "fps": num_steps / max(el, 1e-6)})
        best = max(best, r)
        print(f"step {num_steps:>11,} | reward {r:8.3f} | {el:7.1f}s | "
              f"{num_steps/max(el,1e-6):8.0f} steps/s", flush=True)
        (out_dir / "metrics.json").write_text(json.dumps(metrics_log, indent=2))

    def policy_params_fn(num_steps, make_policy, params):
        if num_steps > 0:
            try:
                brax_model.save_params(str(out_dir / f"params_step{int(num_steps)}"), params)
                brax_model.save_params(str(out_dir / "final_params"), params)
            except Exception as exc:  # pragma: no cover
                print(f"  ckpt save failed at {num_steps}: {exc}", flush=True)

    def network_factory(obs_size, action_size, preprocess_observations_fn):
        return ppo_networks.make_ppo_networks(
            obs_size, action_size, preprocess_observations_fn=preprocess_observations_fn,
            policy_hidden_layer_sizes=tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128))),
            value_hidden_layer_sizes=tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128))),
        )

    train_fn = functools.partial(
        ppo_train_module.train,
        num_timesteps=args.num_timesteps,
        num_evals=args.num_evals,
        reward_scaling=cfg.get("reward_scaling", 1.0),
        episode_length=cfg.get("episode_length", env._config.episode_length),
        normalize_observations=cfg.get("normalize_observations", True),
        action_repeat=cfg.get("action_repeat", 1),
        unroll_length=cfg.get("unroll_length", 20),
        num_minibatches=cfg.get("num_minibatches", 32),
        num_updates_per_batch=cfg.get("num_updates_per_batch", 4),
        discounting=cfg.get("discounting", 0.97),
        learning_rate=cfg.get("learning_rate", 3e-4),
        entropy_cost=cfg.get("entropy_cost", 1e-2),
        num_envs=args.num_envs,
        batch_size=cfg.get("batch_size", 256),
        max_grad_norm=cfg.get("max_grad_norm", 1.0),
        clipping_epsilon=cfg.get("clipping_epsilon", 0.3),
        gae_lambda=cfg.get("gae_lambda", 0.95),
        num_resets_per_eval=cfg.get("num_resets_per_eval", 1),
        network_factory=network_factory,
        seed=args.seed,
        wrap_env_fn=wrap_fn,
        policy_params_fn=policy_params_fn,
        progress_fn=progress,
    )
    _, params, _ = train_fn(environment=env)
    brax_model.save_params(str(out_dir / "final_params"), params)
    (out_dir / "manifest.json").write_text(json.dumps({
        "env": "OmniH1(H1JoystickGaitTracking + command-zeroing)",
        "regime": "brax_ppo_playground",
        "stand_prob": args.stand_prob,
        "tracking_ang_vel": args.tracking_ang_vel,
        "num_timesteps": args.num_timesteps,
        "num_envs": args.num_envs,
        "best_reward": best,
        "seed": args.seed,
    }, indent=2))
    print(f"saved {out_dir/'final_params'} best_reward={best:.3f}", flush=True)
    return out_dir / "final_params"


def main(argv: list[str] | None = None) -> int:
    _resolve_jax_platform()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--num-timesteps", type=int, default=150_000_000)
    p.add_argument("--num-envs", type=int, default=8192)
    p.add_argument("--num-evals", type=int, default=30)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--stand-prob", type=float, default=0.15)
    p.add_argument("--tracking-ang-vel", type=float, default=2.0)
    p.add_argument("--out", type=Path, default=Path("/tmp/robotwalk/h1_omni"))
    args = p.parse_args(argv)
    train(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
