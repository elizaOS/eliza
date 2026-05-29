"""Train, evaluate, and render a text/joystick-conditioned BIPEDAL walking policy
with Brax PPO on GPU (MuJoCo Playground envs).

The joystick locomotion envs put the velocity command ``[vx, vy, yaw_rate]`` in
the observation, so a single trained policy follows different *goals*: walk
forward/backward, strafe, turn, or stand. That command is exactly what a text
instruction resolves to (see ``TEXT_COMMANDS``), which makes this an honest
"pursue different goals from text" demonstration.

Why PPO here and Alberta elsewhere: a 12+-actuator biped cannot be learned from a
single online stream on this hardware (verified — Stream-AC stalls at the
immediate-fall optimum). Brax PPO with massive env parallelism on GPU is the
proven way to get a real gait. The Alberta *continual-learning* layer is then
demonstrated on top of this learned representation (see the continual scripts).

mujoco 3.8.1 defaults to ``impl=warp`` which is broken with the installed warp;
we force ``impl=jax`` (MJX-on-JAX), which runs on CUDA.

Examples::

    # short smoke (confirm it walks, measure speed/mem)
    uv run python scripts/train_biped_walk.py --env BerkeleyHumanoidJoystickFlatTerrain \
        --num-timesteps 15000000 --num-envs 4096 --out checkpoints/biped_walk_smoke --render

    # eval+render an existing checkpoint across text commands
    uv run python scripts/train_biped_walk.py --env BerkeleyHumanoidJoystickFlatTerrain \
        --eval-only --out checkpoints/biped_walk --render
"""

from __future__ import annotations

import argparse
import functools
import json
import time
from pathlib import Path

import numpy as np

# Text instruction -> joystick command [vx (m/s), vy (m/s), yaw_rate (rad/s)].
TEXT_COMMANDS: dict[str, tuple[float, float, float]] = {
    "walk forward": (1.0, 0.0, 0.0),
    "walk backward": (-1.0, 0.0, 0.0),
    "strafe left": (0.0, 0.5, 0.0),
    "strafe right": (0.0, -0.5, 0.0),
    "turn left": (0.0, 0.0, 1.0),
    "turn right": (0.0, 0.0, -1.0),
    "stand still": (0.0, 0.0, 0.0),
}


def load_env(env_name: str):
    from mujoco_playground import registry

    return registry.load(env_name, config_overrides={"impl": "jax"})


def _ppo_config(env_name: str, num_timesteps: int, num_envs: int, num_evals: int) -> dict:
    from mujoco_playground.config import locomotion_params

    cfg = dict(locomotion_params.brax_ppo_config(env_name))
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


def train(env_name: str, *, num_timesteps: int, num_envs: int, num_evals: int, seed: int, out_dir: Path) -> Path:
    import jax
    from brax.io import model as brax_model
    from brax.training.agents.ppo import train as ppo_train_module

    try:
        from mujoco_playground import wrapper as mjx_wrapper

        wrap_fn = mjx_wrapper.wrap_for_brax_training
    except Exception:  # pragma: no cover
        from mujoco_playground._src.wrapper import wrap_for_brax_training as wrap_fn

    env = load_env(env_name)
    cfg = _ppo_config(env_name, num_timesteps, num_envs, num_evals)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"JAX backend: {jax.default_backend()} devices={jax.devices()}", flush=True)
    print(f"Env {env_name}: action={env.action_size} obs={env.observation_size} dt={env.dt}", flush=True)
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
        print(f"step {num_steps:>12,} | reward {reward:9.3f} | {elapsed:7.1f}s | {fps:9.0f} env-steps/s", flush=True)
        (out_dir / "metrics.json").write_text(json.dumps(metrics_log, indent=2))

    saved = {}

    def policy_params_fn(num_steps, make_policy, params):
        saved["params"] = params

    train_fn = functools.partial(
        ppo_train_module.train,
        num_timesteps=cfg["num_timesteps"],
        num_evals=cfg["num_evals"],
        reward_scaling=cfg.get("reward_scaling", 1.0),
        episode_length=cfg.get("episode_length", 1000),
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

    _make_inference_fn, params, _ = train_fn(environment=env)
    final_path = out_dir / "final_params"
    brax_model.save_params(str(final_path), params)
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "env": env_name,
                "regime": "brax_ppo_playground_joystick",
                "impl": "jax",
                "num_timesteps": num_timesteps,
                "num_envs": num_envs,
                "action_size": int(env.action_size),
                "best_reward": best_reward,
                "seed": seed,
                "ckpt": "final_params",
                "text_commands": {k: list(v) for k, v in TEXT_COMMANDS.items()},
            },
            indent=2,
            default=str,
        )
    )
    print(f"saved {final_path} best_reward={best_reward:.3f}", flush=True)
    return final_path


def _make_inference(env_name: str, params_path: Path):
    from brax.io import model as brax_model
    from brax.training.acme import running_statistics
    from brax.training.agents.ppo import networks as ppo_networks

    env = load_env(env_name)
    cfg = _ppo_config(env_name, 1, 1, 1)
    nf = cfg.get("network_factory", {})
    networks = ppo_networks.make_ppo_networks(
        env.observation_size,
        env.action_size,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128))),
        value_hidden_layer_sizes=tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128))),
    )
    make_policy = ppo_networks.make_inference_fn(networks)
    params = brax_model.load_params(str(params_path))
    return env, make_policy(params, deterministic=True)


def _quat_yaw(q) -> float:
    w, x, y, z = [float(v) for v in q]
    return float(np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))


def evaluate_commands(env_name: str, params_path: Path, *, eval_steps: int, seed: int, render: bool, out_dir: Path) -> dict:
    import jax
    import jax.numpy as jp

    env, inference_fn = _make_inference(env_name, params_path)
    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    jit_act = jax.jit(inference_fn)
    out_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {"env": env_name, "commands": {}}
    render_states = None
    for text, cmd in TEXT_COMMANDS.items():
        rng = jax.random.PRNGKey(seed)
        state = jit_reset(rng)
        cmd_arr = jp.array(cmd, dtype=jp.float32)
        state.info["command"] = cmd_arr
        q0 = np.asarray(state.data.qpos)
        x0, y0, yaw0 = float(q0[0]), float(q0[1]), _quat_yaw(q0[3:7])
        xs, ys, zs, vxs, vys, yaws = [x0], [y0], [float(q0[2])], [], [], [yaw0]
        states = [state]
        for _ in range(eval_steps):
            act_rng, rng = jax.random.split(rng)
            action, _ = jit_act(state.obs, act_rng)
            state = jit_step(state, action)
            state.info["command"] = cmd_arr
            states.append(state)
            q = np.asarray(state.data.qpos)
            xs.append(float(q[0])); ys.append(float(q[1])); zs.append(float(q[2]))
            yaws.append(_quat_yaw(q[3:7]))
            qv = np.asarray(state.data.qvel)
            vxs.append(float(qv[0])); vys.append(float(qv[1]))
            if bool(np.asarray(state.done)):
                break
        n = len(xs) - 1
        dx, dy = xs[-1] - x0, ys[-1] - y0
        dyaw = yaws[-1] - yaw0
        mean_vx = float(np.mean(vxs)) if vxs else 0.0
        mean_vy = float(np.mean(vys)) if vys else 0.0
        fell = n < eval_steps
        # "follows the goal": did the agent move in the commanded way without falling?
        if cmd == (0.0, 0.0, 0.0):
            follows = (not fell) and abs(dx) < 0.5 and abs(dy) < 0.5
        elif abs(cmd[0]) > 0:
            follows = (not fell) and np.sign(dx) == np.sign(cmd[0]) and abs(dx) >= 0.5
        elif abs(cmd[1]) > 0:
            follows = (not fell) and np.sign(dy) == np.sign(cmd[1]) and abs(dy) >= 0.3
        else:  # yaw
            follows = (not fell) and np.sign(dyaw) == np.sign(cmd[2]) and abs(dyaw) >= 0.3
        report["commands"][text] = {
            "command": list(cmd), "steps": n, "delta_x_m": dx, "delta_y_m": dy,
            "delta_yaw_rad": dyaw, "mean_base_vx": mean_vx, "mean_base_vy": mean_vy,
            "min_base_z_m": float(np.min(zs)), "fell": fell, "follows_goal": bool(follows),
        }
        print(f"  [{text:13s}] cmd={cmd} dx={dx:+.2f} dy={dy:+.2f} dyaw={dyaw:+.2f} z_min={np.min(zs):.2f} fell={fell} follows={bool(follows)}", flush=True)
        if render and text == "walk forward":
            render_states = states

    report["n_commands_followed"] = sum(c["follows_goal"] for c in report["commands"].values())
    report["n_commands"] = len(report["commands"])
    report["walks_and_follows"] = report["commands"]["walk forward"]["follows_goal"]
    (out_dir / "walk_eval.json").write_text(json.dumps(report, indent=2))

    if render and render_states is not None:
        frames = env.render(render_states, height=240, width=320)
        import imageio.v2 as imageio

        with imageio.get_writer(str(out_dir / "walk_forward.mp4"), fps=int(round(1.0 / float(env.dt))), macro_block_size=None) as w:
            for fr in frames:
                w.append_data(np.asarray(fr))
        report["video"] = str(out_dir / "walk_forward.mp4")
    print(f"followed {report['n_commands_followed']}/{report['n_commands']} commands; walks={report['walks_and_follows']}", flush=True)
    return report


def main(argv: list[str] | None = None) -> int:
    import os

    os.environ.setdefault("XLA_PYTHON_CLIENT_MEM_FRACTION", "0.9")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env", default="BerkeleyHumanoidJoystickFlatTerrain")
    p.add_argument("--num-timesteps", type=int, default=60_000_000)
    p.add_argument("--num-envs", type=int, default=4096)
    p.add_argument("--num-evals", type=int, default=10)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, default=Path("checkpoints/biped_walk"))
    p.add_argument("--eval-only", action="store_true")
    p.add_argument("--eval-steps", type=int, default=500)
    p.add_argument("--render", action="store_true")
    args = p.parse_args(argv)

    if not args.eval_only:
        train(args.env, num_timesteps=args.num_timesteps, num_envs=args.num_envs,
              num_evals=args.num_evals, seed=args.seed, out_dir=args.out)
    evaluate_commands(args.env, args.out / "final_params", eval_steps=args.eval_steps,
                      seed=args.seed, render=args.render, out_dir=args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
