"""Train, evaluate, and render an off-the-shelf MuJoCo Playground bipedal
locomotion policy (Unitree H1/G1, Berkeley Humanoid) with Brax PPO.

This is the validated "off-the-shelf done right" path: the playground
locomotion envs ship tuned PPO configs + domain randomization and are the
sim2real-proven reference for these robots. We train one, then run an
HONEST forward-walk evaluation that measures net base displacement in the
commanded direction, forward-velocity tracking, base-height stability, and
alternating foot contacts — not merely "stayed upright".

CPU note: mujoco 3.8.1 MJX defaults to ``impl=warp`` which requires CUDA.
We force ``impl=jax`` so this runs on a CPU-only host (``JAX_PLATFORMS=cpu``).

Examples::

    # short throughput benchmark
    JAX_PLATFORMS=cpu uv run python scripts/train_playground_locomotion.py \
        --env H1JoystickGaitTracking --num-timesteps 2000000 \
        --num-envs 2048 --num-evals 4 --out checkpoints/h1_walk_bench

    # evaluate + render a trained checkpoint walking forward
    JAX_PLATFORMS=cpu uv run python scripts/train_playground_locomotion.py \
        --env H1JoystickGaitTracking --eval-only --out checkpoints/h1_walk \
        --command 1.0 0.0 0.0 --render --eval-steps 500
"""

from __future__ import annotations

import argparse
import functools
import json
import time
from pathlib import Path

import numpy as np


def _force_cpu_jax_impl() -> None:
    import os

    # Force CPU only when no GPU is requested. When the caller sets
    # MILADY_ROBOT_USE_GPU=1 we leave JAX_PLATFORMS unset so jax can pick up
    # the 5090 via the CUDA PJRT plugin.
    if os.environ.get("MILADY_ROBOT_USE_GPU") != "1":
        os.environ.setdefault("JAX_PLATFORMS", "cpu")
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    # Offscreen GL for headless video rendering.
    os.environ.setdefault("MUJOCO_GL", "egl")
    os.environ.setdefault("PYOPENGL_PLATFORM", "egl")


def load_env(env_name: str, *, impl: str = "jax"):
    from mujoco_playground import registry

    return registry.load(env_name, config_overrides={"impl": impl})


def _ppo_config(env_name: str, num_timesteps: int, num_envs: int, num_evals: int) -> dict:
    from mujoco_playground.config import locomotion_params

    params = locomotion_params.brax_ppo_config(env_name)
    cfg = dict(params)
    cfg["num_timesteps"] = num_timesteps
    cfg["num_envs"] = num_envs
    cfg["num_evals"] = num_evals
    return cfg


def _network_factory(cfg: dict):
    from brax.training.agents.ppo import networks as ppo_networks

    nf = cfg.get("network_factory", {})
    policy_sizes = tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128)))
    value_sizes = tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128)))

    def factory(obs_size, action_size, preprocess_observations_fn):
        return ppo_networks.make_ppo_networks(
            obs_size,
            action_size,
            preprocess_observations_fn=preprocess_observations_fn,
            policy_hidden_layer_sizes=policy_sizes,
            value_hidden_layer_sizes=value_sizes,
        )

    return factory


def train(
    env_name: str,
    *,
    num_timesteps: int,
    num_envs: int,
    num_evals: int,
    seed: int,
    out_dir: Path,
) -> Path:
    import jax
    from brax.training.agents.ppo import train as ppo_train_module
    from brax.io import model as brax_model

    try:
        from mujoco_playground import wrapper as mjx_wrapper

        wrap_fn = mjx_wrapper.wrap_for_brax_training
    except Exception:  # pragma: no cover - import path varies by version
        from mujoco_playground._src.wrapper import wrap_for_brax_training as wrap_fn

    env = load_env(env_name)
    cfg = _ppo_config(env_name, num_timesteps, num_envs, num_evals)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"JAX backend: {jax.default_backend()} devices={jax.devices()}", flush=True)
    print(f"Env {env_name}: action_size={env.action_size} obs={env.observation_size} dt={env.dt}", flush=True)
    print(f"PPO: timesteps={num_timesteps:,} num_envs={num_envs} evals={num_evals}", flush=True)

    metrics_log: list[dict] = []
    best_reward = float("-inf")
    start = time.time()

    def progress(num_steps, metrics):
        nonlocal best_reward
        reward = float(metrics.get("eval/episode_reward", metrics.get("eval/episode_reward_mean", 0.0)))
        elapsed = time.time() - start
        fps = num_steps / max(elapsed, 1e-6)
        metrics_log.append({"steps": int(num_steps), "reward": reward, "elapsed": elapsed, "fps": fps})
        best_reward = max(best_reward, reward)
        print(f"step {num_steps:>11,} | reward {reward:8.3f} | {elapsed:7.1f}s | {fps:8.0f} steps/s", flush=True)
        (out_dir / "metrics.json").write_text(json.dumps(metrics_log, indent=2))

    saved_params = {}

    def policy_params_fn(num_steps, make_policy, params):
        saved_params["make_policy"] = make_policy
        saved_params["params"] = params
        # Persist every eval checkpoint so a long run can be rendered/resumed
        # from the latest snapshot even if interrupted before completion.
        if num_steps > 0:
            try:
                brax_model.save_params(str(out_dir / f"params_step{int(num_steps)}"), params)
                brax_model.save_params(str(out_dir / "final_params"), params)
            except Exception as exc:  # pragma: no cover - disk/serialize edge
                print(f"  checkpoint save failed at {num_steps}: {exc}", flush=True)

    train_fn = functools.partial(
        ppo_train_module.train,
        num_timesteps=cfg["num_timesteps"],
        num_evals=cfg["num_evals"],
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
        num_envs=cfg["num_envs"],
        batch_size=cfg.get("batch_size", 256),
        max_grad_norm=cfg.get("max_grad_norm", 1.0),
        clipping_epsilon=cfg.get("clipping_epsilon", 0.2),
        gae_lambda=cfg.get("gae_lambda", 0.95),
        network_factory=_network_factory(cfg),
        seed=seed,
        wrap_env_fn=wrap_fn,
        policy_params_fn=policy_params_fn,
        progress_fn=progress,
    )

    make_inference_fn, params, _ = train_fn(environment=env)

    final_path = out_dir / "final_params"
    brax_model.save_params(str(final_path), params)
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "env": env_name,
                "regime": "brax_ppo_playground",
                "impl": "jax",
                "num_timesteps": num_timesteps,
                "num_envs": num_envs,
                "action_size": int(env.action_size),
                "obs_size": int(env.observation_size) if not isinstance(env.observation_size, dict) else env.observation_size,
                "best_reward": best_reward,
                "seed": seed,
                "ckpt": "final_params",
            },
            indent=2,
            default=str,
        )
    )
    print(f"saved {final_path} best_reward={best_reward:.3f}", flush=True)
    return final_path


def _make_inference(env_name: str, params_path: Path):
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.training.acme import running_statistics
    from brax.io import model as brax_model

    env = load_env(env_name)
    cfg = _ppo_config(env_name, 1, 1, 1)
    nf = cfg.get("network_factory", {})
    obs_size = env.observation_size
    networks = ppo_networks.make_ppo_networks(
        obs_size,
        env.action_size,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128))),
        value_hidden_layer_sizes=tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128))),
    )
    make_policy = ppo_networks.make_inference_fn(networks)
    params = brax_model.load_params(str(params_path))
    inference_fn = make_policy(params, deterministic=True)
    return env, inference_fn


def evaluate_and_render(
    env_name: str,
    params_path: Path,
    *,
    command: tuple[float, float, float],
    eval_steps: int,
    seed: int,
    render: bool,
    out_dir: Path,
) -> dict:
    import jax
    import jax.numpy as jp

    env, inference_fn = _make_inference(env_name, params_path)
    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    jit_act = jax.jit(inference_fn)

    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    cmd = jp.array(command, dtype=jp.float32)
    state.info["command"] = cmd

    def base_xy_z(st):
        qpos = np.asarray(st.data.qpos)
        return float(qpos[0]), float(qpos[1]), float(qpos[2])

    def foot_contacts(st):
        lc = st.info.get("last_contact")
        if lc is None:
            return None, None
        arr = np.asarray(lc).ravel().astype(bool)
        if arr.shape[0] < 2:
            return None, None
        return bool(arr[0]), bool(arr[1])

    states = [state]
    base_pts = [list(base_xy_z(state))]
    left_contacts, right_contacts = [], []
    rewards = []
    fell = False
    for _ in range(eval_steps):
        act_rng, rng = jax.random.split(rng)
        action, _ = jit_act(state.obs, act_rng)
        state = jit_step(state, action)
        state.info["command"] = cmd  # hold command fixed for the demo
        states.append(state)
        base_pts.append(list(base_xy_z(state)))
        lcc, rcc = foot_contacts(state)
        if lcc is not None:
            left_contacts.append(lcc)
            right_contacts.append(rcc)
        rewards.append(float(np.asarray(state.reward)))
        if bool(np.asarray(state.done)):
            fell = True
            break

    from eliza_robot.rl.locomotion_metrics import evaluate_walk_trajectory

    dt = float(env.dt)
    cmd_vx = float(command[0])
    base_arr = np.asarray(base_pts, dtype=np.float64)
    metrics = evaluate_walk_trajectory(
        base_arr,
        commanded_velocity_m_s=cmd_vx,
        dt_s=dt,
        fell=fell,
        left_contact=np.asarray(left_contacts) if left_contacts else None,
        right_contact=np.asarray(right_contacts) if right_contacts else None,
        # H1/G1 base stands ~0.6-1.0m; require it to stay clearly off the floor.
        min_base_height_m=0.55,
    )
    report = {"env": env_name, "command": list(command), "mean_reward": float(np.mean(rewards)) if rewards else 0.0}
    report.update(metrics.to_dict())

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "walk_eval.json").write_text(json.dumps(report, indent=2))

    if render:
        frames = env.render(states, height=240, width=320)
        _write_mp4(frames, out_dir / "walk_forward.mp4", fps=int(round(1.0 / dt)))
        report["video"] = str(out_dir / "walk_forward.mp4")
    print(json.dumps(report, indent=2), flush=True)
    return report


def _write_mp4(frames, path: Path, fps: int) -> None:
    import imageio.v2 as imageio

    with imageio.get_writer(str(path), fps=fps, macro_block_size=None) as writer:
        for frame in frames:
            writer.append_data(np.asarray(frame))


def main(argv: list[str] | None = None) -> int:
    _force_cpu_jax_impl()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env", default="H1JoystickGaitTracking")
    p.add_argument("--num-timesteps", type=int, default=30_000_000)
    p.add_argument("--num-envs", type=int, default=2048)
    p.add_argument("--num-evals", type=int, default=10)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, default=Path("checkpoints/playground_walk"))
    p.add_argument("--eval-only", action="store_true")
    p.add_argument("--command", type=float, nargs=3, default=[1.0, 0.0, 0.0])
    p.add_argument("--eval-steps", type=int, default=500)
    p.add_argument("--render", action="store_true")
    args = p.parse_args(argv)

    if not args.eval_only:
        train(
            args.env,
            num_timesteps=args.num_timesteps,
            num_envs=args.num_envs,
            num_evals=args.num_evals,
            seed=args.seed,
            out_dir=args.out,
        )
    evaluate_and_render(
        args.env,
        args.out / "final_params",
        command=tuple(args.command),
        eval_steps=args.eval_steps,
        seed=args.seed,
        render=args.render,
        out_dir=args.out,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
