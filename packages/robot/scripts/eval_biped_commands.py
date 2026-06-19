"""Standalone evaluator + loader for a Brax-PPO joystick bipedal walking policy.

Demonstrates TEXT-conditioned goal following: each natural-language instruction
is resolved to a joystick velocity command ``[vx, vy, yaw_rate]`` via
:func:`resolve_command`, the deterministic policy is rolled out holding that
command fixed, and we measure whether the robot actually moved in the commanded
way (``follows_goal``).

The policy/network rebuild mirrors ``scripts/train_biped_walk.py`` (``_make_inference``):
the MuJoCo-Playground joystick env carries the command in ``state.info["command"]``,
so re-injecting a fixed command each step pins the goal for the whole rollout.

CPU only — this script forces ``JAX_PLATFORMS=cpu`` so it never touches a GPU
that may be training. Example::

    JAX_PLATFORMS=cpu .venv/bin/python scripts/eval_biped_commands.py \
        --ckpt /tmp/biped_smoke/final_params --eval-steps 200 --out-dir /tmp/eval_cmd
"""

from __future__ import annotations

import argparse
import json
import os

# Force CPU before any JAX import so we never grab a GPU that is training.
os.environ.setdefault("JAX_PLATFORMS", "cpu")

import sys
from pathlib import Path

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.rl.text_conditioned.joystick_text import (  # noqa: E402
    CANONICAL_COMMANDS,
    resolve_command,
)


def _load_env(env_name: str):
    """Load the joystick env on JAX/MJX (CPU under JAX_PLATFORMS=cpu)."""
    from mujoco_playground import registry

    return registry.load(env_name, config_overrides={"impl": "jax"})


def _ppo_network_factory_sizes(env_name: str):
    """Network layer sizes for the env's Brax PPO config (matches training)."""
    from mujoco_playground.config import locomotion_params

    cfg = dict(locomotion_params.brax_ppo_config(env_name))
    nf = cfg.get("network_factory", {})
    policy_sizes = tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128)))
    value_sizes = tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128)))
    return policy_sizes, value_sizes


def _make_inference(env_name: str, params_path: Path):
    """Rebuild the deterministic Brax PPO inference policy from a checkpoint.

    Replicates ``scripts/train_biped_walk.py:_make_inference`` so this file is
    self-contained.
    """
    from brax.io import model as brax_model
    from brax.training.acme import running_statistics
    from brax.training.agents.ppo import networks as ppo_networks

    env = _load_env(env_name)
    policy_sizes, value_sizes = _ppo_network_factory_sizes(env_name)
    networks = ppo_networks.make_ppo_networks(
        env.observation_size,
        env.action_size,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=policy_sizes,
        value_hidden_layer_sizes=value_sizes,
    )
    make_policy = ppo_networks.make_inference_fn(networks)
    params = brax_model.load_params(str(params_path))
    return env, make_policy(params, deterministic=True)


def _quat_yaw(q) -> float:
    """Yaw (rad) from a root quaternion ``[w, x, y, z]`` (qpos[3:7])."""
    w, x, y, z = (float(v) for v in q)
    return float(np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))


def _follows_goal(cmd: tuple[float, float, float], *, fell: bool, dx: float, dy: float, dyaw: float) -> bool:
    """Did the robot move in the commanded way without falling?

    forward/back: sign(dx)==sign(vx) and |dx|>=0.5
    strafe:       sign(dy)==sign(vy) and |dy|>=0.3
    turn:         sign(dyaw)==sign(yaw) and |dyaw|>=0.3
    stand:        not fell and |dx|<0.5 and |dy|<0.5
    """
    vx, vy, yaw = cmd
    if vx == 0.0 and vy == 0.0 and yaw == 0.0:
        return (not fell) and abs(dx) < 0.5 and abs(dy) < 0.5
    if vx != 0.0:
        return (not fell) and np.sign(dx) == np.sign(vx) and abs(dx) >= 0.5
    if vy != 0.0:
        return (not fell) and np.sign(dy) == np.sign(vy) and abs(dy) >= 0.3
    return (not fell) and np.sign(dyaw) == np.sign(yaw) and abs(dyaw) >= 0.3


def _rollout(env, jit_reset, jit_step, jit_act, jax, jp, cmd: tuple[float, float, float], *, eval_steps: int, seed: int) -> dict:
    """Roll out the deterministic policy holding ``cmd`` fixed; return metrics."""
    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    cmd_arr = jp.array(cmd, dtype=jp.float32)
    state.info["command"] = cmd_arr

    q0 = np.asarray(state.data.qpos)
    x0, y0, yaw0 = float(q0[0]), float(q0[1]), _quat_yaw(q0[3:7])
    xs, ys, zs = [x0], [y0], [float(q0[2])]
    yaws = [yaw0]
    vxs: list[float] = []
    vys: list[float] = []

    for _ in range(eval_steps):
        act_rng, rng = jax.random.split(rng)
        action, _ = jit_act(state.obs, act_rng)
        state = jit_step(state, action)
        state.info["command"] = cmd_arr
        q = np.asarray(state.data.qpos)
        xs.append(float(q[0]))
        ys.append(float(q[1]))
        zs.append(float(q[2]))
        yaws.append(_quat_yaw(q[3:7]))
        qv = np.asarray(state.data.qvel)
        vxs.append(float(qv[0]))
        vys.append(float(qv[1]))
        if bool(np.asarray(state.done)):
            break

    n = len(xs) - 1
    dx, dy = xs[-1] - x0, ys[-1] - y0
    dyaw = yaws[-1] - yaw0
    mean_vx = float(np.mean(vxs)) if vxs else 0.0
    mean_vy = float(np.mean(vys)) if vys else 0.0
    fell = n < eval_steps
    follows = _follows_goal(cmd, fell=fell, dx=dx, dy=dy, dyaw=dyaw)
    return {
        "command": list(cmd),
        "steps": n,
        "delta_x_m": dx,
        "delta_y_m": dy,
        "delta_yaw_rad": dyaw,
        "mean_base_vx": mean_vx,
        "mean_base_vy": mean_vy,
        "min_base_z_m": float(np.min(zs)),
        "fell": fell,
        "follows_goal": bool(follows),
    }


def evaluate(env_name: str, ckpt: Path, texts: list[str], *, eval_steps: int, seed: int, out_dir: Path) -> dict:
    import jax
    import jax.numpy as jp

    env, inference_fn = _make_inference(env_name, ckpt)
    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    jit_act = jax.jit(inference_fn)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"JAX backend: {jax.default_backend()} env={env_name} action={env.action_size}", flush=True)

    report: dict = {
        "env": env_name,
        "ckpt": str(ckpt),
        "eval_steps": eval_steps,
        "seed": seed,
        "text_to_command": {},
        "commands": {},
    }
    for text in texts:
        cmd = resolve_command(text).as_tuple()
        report["text_to_command"][text] = list(cmd)
        metrics = _rollout(env, jit_reset, jit_step, jit_act, jax, jp, cmd, eval_steps=eval_steps, seed=seed)
        report["commands"][text] = metrics
        print(
            f"  [{text:13s}] cmd={cmd} dx={metrics['delta_x_m']:+.2f} dy={metrics['delta_y_m']:+.2f} "
            f"dyaw={metrics['delta_yaw_rad']:+.2f} z_min={metrics['min_base_z_m']:.2f} "
            f"fell={metrics['fell']} follows={metrics['follows_goal']}",
            flush=True,
        )

    report["n_followed"] = sum(m["follows_goal"] for m in report["commands"].values())
    report["n_total"] = len(report["commands"])

    (out_dir / "command_following.json").write_text(json.dumps(report, indent=2))
    (out_dir / "command_following.md").write_text(_render_markdown(report))
    print(f"followed {report['n_followed']}/{report['n_total']} commands", flush=True)
    return report


def _render_markdown(report: dict) -> str:
    lines = [
        f"# Command following — {report['env']}",
        "",
        f"- checkpoint: `{report['ckpt']}`",
        f"- eval_steps: {report['eval_steps']}  seed: {report['seed']}",
        f"- followed: **{report['n_followed']}/{report['n_total']}**",
        "",
        "| text | command (vx,vy,yaw) | dx (m) | dy (m) | dyaw (rad) | mean vx | mean vy | min z (m) | fell | follows |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |",
    ]
    for text, m in report["commands"].items():
        cmd = m["command"]
        lines.append(
            f"| {text} | ({cmd[0]:g}, {cmd[1]:g}, {cmd[2]:g}) | {m['delta_x_m']:+.3f} | "
            f"{m['delta_y_m']:+.3f} | {m['delta_yaw_rad']:+.3f} | {m['mean_base_vx']:+.3f} | "
            f"{m['mean_base_vy']:+.3f} | {m['min_base_z_m']:.3f} | "
            f"{'yes' if m['fell'] else 'no'} | {'yes' if m['follows_goal'] else 'no'} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env", default="BerkeleyHumanoidJoystickFlatTerrain")
    p.add_argument("--ckpt", type=Path, required=True, help="path to a brax final_params checkpoint")
    p.add_argument(
        "--texts",
        nargs="+",
        default=list(CANONICAL_COMMANDS.keys()),
        help="instruction strings (default: the canonical command set)",
    )
    p.add_argument("--eval-steps", type=int, default=500)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out-dir", type=Path, default=Path("/tmp/eval_biped_commands"))
    args = p.parse_args(argv)

    if not args.ckpt.exists():
        p.error(f"checkpoint not found: {args.ckpt}")

    evaluate(
        args.env,
        args.ckpt,
        list(args.texts),
        eval_steps=args.eval_steps,
        seed=args.seed,
        out_dir=args.out_dir,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
