"""Honest walking proof for mujoco_playground locomotion policies.

Self-contained, correct rollout + grading + render for a trained Brax-PPO
playground locomotion checkpoint (Unitree H1/G1, Berkeley Humanoid). This is
the *authoritative* proof path:

  - Reconstructs the exact PPO inference network from the playground config.
  - Rolls out a fixed velocity command deterministically.
  - Extracts REAL per-foot ground contact from the env's foot-floor sensors
    (``left_foot*_floor_found`` / ``right_foot*_floor_found``) — NOT the
    ``info["last_contact"]`` field, which on H1 is constantly ``[1,1]`` and
    silently zeroed the gait-alternation metric.
  - Grades the base-link trajectory with the pure honest gate in
    ``locomotion_metrics`` (forward displacement, velocity tracking, base
    height, lateral drift, alternating foot contacts, no fall).
  - Optionally renders an MP4.

Why a separate module: the trainer's inline eval used the wrong contact
signal. This keeps the honest verification in one owned, unit-tested place
that both the trainer and the walk-gate benchmark can call.

Usage::

    JAX_PLATFORMS=cpu MUJOCO_GL=egl uv run python -m eliza_robot.rl.walk_proof \
        --env H1JoystickGaitTracking --ckpt /path/to/final_params \
        --command 1.0 0.0 0.0 --eval-steps 500 --render --out /tmp/proof
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from eliza_robot.rl.locomotion_metrics import WalkMetrics, evaluate_walk_trajectory


def _foot_floor_sensor_addrs(mj_model) -> tuple[np.ndarray, np.ndarray]:
    """Return (left_addrs, right_addrs) into ``data.sensordata`` for the
    per-foot floor-contact sensors. Empty arrays if the env has none."""
    import mujoco

    left, right = [], []
    for i in range(mj_model.nsensor):
        name = mujoco.mj_id2name(mj_model, mujoco.mjtObj.mjOBJ_SENSOR, i) or ""
        if "floor_found" not in name and "foot" not in name.lower():
            continue
        if "floor_found" not in name:
            continue
        adr = int(mj_model.sensor_adr[i])
        if name.startswith("left_foot"):
            left.append(adr)
        elif name.startswith("right_foot"):
            right.append(adr)
    return np.asarray(left, dtype=np.int32), np.asarray(right, dtype=np.int32)


def _heading_for_command(command: tuple[float, float, float]) -> str:
    vx, vy, _ = command
    if abs(vx) >= abs(vy):
        return "x+" if vx >= 0 else "x-"
    return "y+" if vy >= 0 else "y-"


def load_policy(env_name: str, params_path: str | Path):
    """Reconstruct the playground PPO inference fn + env for a checkpoint."""
    import jax
    from brax.io import model as brax_model
    from brax.training.acme import running_statistics
    from brax.training.agents.ppo import networks as ppo_networks
    from mujoco_playground import registry
    from mujoco_playground.config import locomotion_params

    env = registry.load(env_name, config_overrides={"impl": "jax"})
    cfg = dict(locomotion_params.brax_ppo_config(env_name))
    nf = cfg.get("network_factory", {})
    networks = ppo_networks.make_ppo_networks(
        env.observation_size,
        env.action_size,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128))),
        value_hidden_layer_sizes=tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128))),
    )
    params = brax_model.load_params(str(params_path))
    inference_fn = ppo_networks.make_inference_fn(networks)(params, deterministic=True)
    return env, jax.jit(inference_fn)


def rollout_and_grade(
    env_name: str,
    params_path: str | Path,
    *,
    command: tuple[float, float, float] = (1.0, 0.0, 0.0),
    eval_steps: int = 500,
    seed: int = 0,
    render: bool = False,
    out_dir: str | Path | None = None,
    min_forward_distance_m: float = 0.5,
    max_lateral_drift_m: float = 0.5,
    min_base_height_m: float | None = None,
) -> tuple[WalkMetrics, list, dict]:
    """Roll out a fixed command, grade with the honest gate, optionally render.

    ``min_base_height_m`` defaults to ``None`` -> derived per-robot as
    ``0.82 * initial_base_height`` (e.g. H1 stands ~0.97m -> ~0.80m floor),
    which allows a realistic gait dip but rejects a crouch/collapse. A fixed
    0.55 (the old value) let a near-collapsed H1 pass, so deriving from the
    robot's own standing height keeps the gate honest across robots.

    Returns ``(metrics, states, report)``. ``report`` is a JSON-able dict.
    """
    import jax
    import jax.numpy as jp

    env, act = load_policy(env_name, params_path)
    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    left_adr, right_adr = _foot_floor_sensor_addrs(env.mj_model)
    has_contacts = left_adr.size > 0 and right_adr.size > 0

    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    cmd = jp.asarray(command, dtype=jp.float32)
    state.info["command"] = cmd

    def base_xyz(st):
        q = np.asarray(st.data.qpos)
        return [float(q[0]), float(q[1]), float(q[2])]

    states = [state]
    base_pts = [base_xyz(state)]
    if min_base_height_m is None:
        # Derive a robot-appropriate floor from the standing base height so a
        # crouch/collapse cannot pass while a real gait dip can.
        min_base_height_m = max(0.4, 0.82 * float(base_pts[0][2]))
    left_contact, right_contact = [], []
    rewards = []
    fell = False
    for _ in range(eval_steps):
        act_rng, rng = jax.random.split(rng)
        action, _ = act(state.obs, act_rng)
        state = jit_step(state, action)
        state.info["command"] = cmd  # hold command fixed for the demo
        states.append(state)
        base_pts.append(base_xyz(state))
        if has_contacts:
            sd = np.asarray(state.data.sensordata)
            left_contact.append(bool(sd[left_adr].max() > 0.5))
            right_contact.append(bool(sd[right_adr].max() > 0.5))
        rewards.append(float(np.asarray(state.reward)))
        if bool(np.asarray(state.done)):
            fell = True
            break

    metrics = evaluate_walk_trajectory(
        np.asarray(base_pts, dtype=np.float64),
        commanded_velocity_m_s=float(command[0] if abs(command[0]) >= abs(command[1]) else command[1]),
        dt_s=float(env.dt),
        fell=fell,
        left_contact=np.asarray(left_contact) if left_contact else None,
        right_contact=np.asarray(right_contact) if right_contact else None,
        min_forward_distance_m=min_forward_distance_m,
        max_lateral_drift_m=max_lateral_drift_m,
        min_base_height_m=min_base_height_m,
        heading=_heading_for_command(command),
    )
    report = {
        "env": env_name,
        "checkpoint": str(params_path),
        "command": list(command),
        "mean_reward": float(np.mean(rewards)) if rewards else 0.0,
        "contacts_from": "foot_floor_sensors" if has_contacts else "unavailable",
        **asdict(metrics),
    }

    if out_dir is not None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "walk_eval.json").write_text(json.dumps(report, indent=2) + "\n")
        if render:
            frames = env.render(states, height=240, width=320)
            _write_mp4(frames, out / "walk_forward.mp4", fps=int(round(1.0 / float(env.dt))))
            report["video"] = str(out / "walk_forward.mp4")
            (out / "walk_eval.json").write_text(json.dumps(report, indent=2) + "\n")

    return metrics, states, report


def _write_mp4(frames, path: Path, fps: int) -> None:
    import imageio.v2 as imageio

    with imageio.get_writer(str(path), fps=fps, macro_block_size=None) as writer:
        for frame in frames:
            writer.append_data(np.asarray(frame))


def main(argv: list[str] | None = None) -> int:
    import os

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env", default="H1JoystickGaitTracking")
    p.add_argument("--ckpt", required=True, help="path to final_params (or params_step* file)")
    p.add_argument("--command", type=float, nargs=3, default=[1.0, 0.0, 0.0])
    p.add_argument("--eval-steps", type=int, default=500)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--render", action="store_true")
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args(argv)

    metrics, _, report = rollout_and_grade(
        args.env,
        args.ckpt,
        command=tuple(args.command),
        eval_steps=args.eval_steps,
        seed=args.seed,
        render=args.render,
        out_dir=args.out,
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
