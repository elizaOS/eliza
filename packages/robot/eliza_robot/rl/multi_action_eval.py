"""Text-conditioned multi-action evaluator for a trained playground policy.

This is the authoritative "one velocity-conditioned RL policy, many actions"
proof path. Given a trained joystick/gait checkpoint (e.g. Unitree H1), for each
``(text command, action_type)`` pair it:

  - maps the free-form text to a ``[vx, vy, vyaw]`` velocity command through the
    real bridge (:func:`velocity_from_text`),
  - rolls the deterministic policy out under that fixed command,
  - accumulates base-link kinematics (net dx/dy, cumulative wrapped yaw, real
    per-foot contact switches from the floor sensors, minimum base height,
    whether it fell),
  - grades each action with a *direction-appropriate* honest gate.

Each action's gate is empirically derived and seed-robust. Every action first
requires the robot to stay upright (``not fell`` and ``min_base_z >= 0.7``);
locomotion actions then require real translation in the commanded direction with
alternating foot contacts, turns require real cumulative yaw with little drift,
and ``stand`` requires staying put.

Why a separate owned module: the proof previously lived in a throwaway script
(``/tmp/robotwalk/multi_action_proof.py``). The grading thresholds are a real
contract, so they belong in one unit-tested place that the trainer, the deploy
harness, and the benchmark can all call. The pure :func:`grade_action` has no
sim/jax dependency and is cheap to test against synthetic kinematics.

Usage::

    JAX_PLATFORMS=cpu MUJOCO_GL=egl uv run python -m eliza_robot.rl.multi_action_eval \
        --env H1JoystickGaitTracking --ckpt /path/to/final_params \
        --eval-steps 350 --render --out /tmp/multi_action
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from eliza_robot.rl.locomotion_metrics import count_contact_switches

# Minimum upright base height (metres). Below this the H1 has effectively
# crouched/collapsed; a real gait dip stays above it. Shared by every action.
MIN_UPRIGHT_BASE_Z = 0.7
# Minimum alternating single-stance transitions for a genuine biped gait.
MIN_GAIT_SWITCHES = 2

# The canonical (text command, action_type) pairs. The bridge maps each text to
# a velocity command; the policy is the same one for all of them.
CANONICAL_ACTIONS: tuple[tuple[str, str], ...] = (
    ("walk forward", "forward"),
    ("walk backward", "backward"),
    ("turn left", "turn_left"),
    ("turn right", "turn_right"),
    ("sidestep left", "strafe_left"),
    ("sidestep right", "strafe_right"),
    ("stop", "stand"),
)


def _yaw_from_quat(qpos: np.ndarray) -> float:
    """Yaw (rad) about world-Z from a base orientation quaternion.

    ``qpos[3:7]`` is the free-joint quaternion ``[qw, qx, qy, qz]``.
    """
    qw, qx, qy, qz = (
        float(qpos[3]),
        float(qpos[4]),
        float(qpos[5]),
        float(qpos[6]),
    )
    return math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))


def _wrap_to_pi(angle: float) -> float:
    """Wrap an angle to ``[-pi, pi)``."""
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def grade_action(
    action_type: str,
    dx: float,
    dy: float,
    cum_yaw: float,
    switches: int,
    min_base_z: float,
    fell: bool,
) -> tuple[bool, list[str]]:
    """Grade one action's rollout kinematics against its honest gate.

    Pure: no sim, jax, or env state — only the accumulated scalars. Returns
    ``(passed, fail_reasons)``; ``passed`` is True only when every criterion for
    ``action_type`` holds.

    Common requirement (all actions): ``not fell`` and
    ``min_base_z >= MIN_UPRIGHT_BASE_Z``.

    Per-action requirements:

    - ``forward``: ``dx >= 0.5``, ``|dy| <= 0.8``, ``switches >= 2``.
    - ``backward``: ``dx <= -0.5``, ``|dy| <= 0.8``, ``switches >= 2``.
    - ``turn_left``: ``cum_yaw >= 0.6``, ``hypot(dx, dy) <= 1.0``.
    - ``turn_right``: ``cum_yaw <= -0.6``, ``hypot(dx, dy) <= 1.0``.
    - ``strafe_left``: ``dy >= 0.3``, ``switches >= 2``.
    - ``strafe_right``: ``dy <= -0.3``, ``switches >= 2``.
    - ``stand``: ``|dx| <= 0.5`` and ``|dy| <= 0.5`` and ``|cum_yaw| <= 0.8``.
    """
    fails: list[str] = []
    if fell:
        fails.append("fell")
    if min_base_z < MIN_UPRIGHT_BASE_Z:
        fails.append(f"min_base_z {min_base_z:.2f}<{MIN_UPRIGHT_BASE_Z}")
    gait_ok = switches >= MIN_GAIT_SWITCHES

    if action_type == "forward":
        if dx < 0.5:
            fails.append(f"dx {dx:.2f}<0.5")
        if abs(dy) > 0.8:
            fails.append(f"lateral {abs(dy):.2f}>0.8")
        if not gait_ok:
            fails.append(f"switches {switches}<{MIN_GAIT_SWITCHES}")
    elif action_type == "backward":
        if dx > -0.5:
            fails.append(f"dx {dx:.2f}>-0.5")
        if abs(dy) > 0.8:
            fails.append(f"lateral {abs(dy):.2f}>0.8")
        if not gait_ok:
            fails.append(f"switches {switches}<{MIN_GAIT_SWITCHES}")
    elif action_type == "turn_left":
        if cum_yaw < 0.6:
            fails.append(f"cum_yaw {cum_yaw:.2f}<0.6")
        translation = math.hypot(dx, dy)
        if translation > 1.0:
            fails.append(f"drift {translation:.2f}>1.0")
    elif action_type == "turn_right":
        if cum_yaw > -0.6:
            fails.append(f"cum_yaw {cum_yaw:.2f}>-0.6")
        translation = math.hypot(dx, dy)
        if translation > 1.0:
            fails.append(f"drift {translation:.2f}>1.0")
    elif action_type == "strafe_left":
        if dy < 0.3:
            fails.append(f"dy {dy:.2f}<0.3")
        if not gait_ok:
            fails.append(f"switches {switches}<{MIN_GAIT_SWITCHES}")
    elif action_type == "strafe_right":
        if dy > -0.3:
            fails.append(f"dy {dy:.2f}>-0.3")
        if not gait_ok:
            fails.append(f"switches {switches}<{MIN_GAIT_SWITCHES}")
    elif action_type == "stand":
        if abs(dx) > 0.5 or abs(dy) > 0.5:
            fails.append(f"moved dx{dx:.2f} dy{dy:.2f}")
        if abs(cum_yaw) > 0.8:
            fails.append(f"spun cum_yaw{cum_yaw:.2f}")
    else:
        raise ValueError(f"unknown action_type {action_type!r}")

    return (len(fails) == 0), fails


def rollout_action(
    env,
    act_fn,
    left_adr: np.ndarray,
    right_adr: np.ndarray,
    command: tuple[float, float, float],
    eval_steps: int,
    seed: int,
) -> dict:
    """Roll the policy out under a fixed velocity command and return metrics.

    Holds ``command`` fixed for the whole rollout, accumulating net base
    displacement, cumulative wrapped yaw, real per-foot contact switches, the
    minimum base height, and whether the episode terminated early (a fall).

    Args:
        env: loaded playground env (from :func:`load_policy`).
        act_fn: jitted inference fn ``(obs, rng) -> (action, _)``.
        left_adr / right_adr: ``data.sensordata`` addresses of the per-foot
            floor-contact sensors (from ``_foot_floor_sensor_addrs``).
        command: ``(vx, vy, vyaw)`` velocity command.
        eval_steps: rollout length.
        seed: PRNG seed.

    Returns a dict with ``dx, dy, cum_yaw, switches, min_base_z, fell, steps``
    and the collected env ``states`` (for optional rendering).
    """
    import jax
    import jax.numpy as jp

    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    cmd = jp.asarray(command, dtype=jp.float32)

    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    state.info["command"] = cmd

    q0 = np.asarray(state.data.qpos)
    x0, y0 = float(q0[0]), float(q0[1])
    yaw_prev = _yaw_from_quat(q0)
    min_base_z = float(q0[2])
    cum_yaw = 0.0
    left_contact: list[bool] = []
    right_contact: list[bool] = []
    fell = False
    steps = 0
    states = [state]

    for _ in range(eval_steps):
        act_rng, rng = jax.random.split(rng)
        action, _ = act_fn(state.obs, act_rng)
        state = jit_step(state, action)
        state.info["command"] = cmd  # hold the command fixed for the demo
        states.append(state)
        steps += 1

        q = np.asarray(state.data.qpos)
        min_base_z = min(min_base_z, float(q[2]))
        yaw = _yaw_from_quat(q)
        cum_yaw += _wrap_to_pi(yaw - yaw_prev)
        yaw_prev = yaw

        sd = np.asarray(state.data.sensordata)
        left_contact.append(bool(sd[left_adr].max() > 0.5))
        right_contact.append(bool(sd[right_adr].max() > 0.5))

        if bool(np.asarray(state.done)):
            fell = True
            break

    q = np.asarray(state.data.qpos)
    dx, dy = float(q[0]) - x0, float(q[1]) - y0
    switches = count_contact_switches(np.asarray(left_contact), np.asarray(right_contact))

    return {
        "dx": dx,
        "dy": dy,
        "cum_yaw": cum_yaw,
        "switches": int(switches),
        "min_base_z": min_base_z,
        "fell": fell,
        "steps": steps,
        "states": states,
    }


def evaluate_all_actions(
    env_name: str,
    params_path: str | Path,
    eval_steps: int = 350,
    seed: int = 1,
    render: bool = False,
    out_dir: str | Path | None = None,
) -> dict:
    """Evaluate every canonical text->action pair against its honest gate.

    Loads the policy once, then for each ``(text, action_type)`` in
    :data:`CANONICAL_ACTIONS` maps the text to a velocity command, rolls out,
    grades, and (optionally) renders a per-action MP4.

    Returns ``{"checkpoint", "env", "actions": [...], "n_pass", "all_pass"}``.
    Each entry in ``actions`` is JSON-able (no env states).
    """
    from eliza_robot.rl.meta.locomotion_command import velocity_from_text
    from eliza_robot.rl.walk_proof import (
        _foot_floor_sensor_addrs,
        _write_mp4,
        load_policy,
    )

    env, act_fn = load_policy(env_name, params_path)
    left_adr, right_adr = _foot_floor_sensor_addrs(env.mj_model)
    if left_adr.size == 0 or right_adr.size == 0:
        raise ValueError(
            f"env {env_name!r} exposes no per-foot floor-contact sensors; "
            "the gait-switch gate cannot be evaluated honestly"
        )
    dt = float(env.dt)

    out: Path | None = None
    if out_dir is not None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)

    actions: list[dict] = []
    for text, action_type in CANONICAL_ACTIONS:
        cmd = velocity_from_text(text)
        metrics = rollout_action(
            env,
            act_fn,
            left_adr,
            right_adr,
            cmd.as_tuple(),
            eval_steps,
            seed,
        )
        passed, fail_reasons = grade_action(
            action_type,
            metrics["dx"],
            metrics["dy"],
            metrics["cum_yaw"],
            metrics["switches"],
            metrics["min_base_z"],
            metrics["fell"],
        )
        record = {
            "text": text,
            "action": action_type,
            "command": list(cmd.as_tuple()),
            "steps": metrics["steps"],
            "dx": round(metrics["dx"], 3),
            "dy": round(metrics["dy"], 3),
            "cum_yaw_rad": round(metrics["cum_yaw"], 3),
            "switches": metrics["switches"],
            "min_base_z": round(metrics["min_base_z"], 3),
            "fell": metrics["fell"],
            "passed": passed,
            "fail_reasons": fail_reasons,
        }

        if render and out is not None:
            frames = env.render(metrics["states"], height=240, width=320)
            video = out / f"{action_type}.mp4"
            _write_mp4(frames, video, fps=int(round(1.0 / dt)))
            record["video"] = str(video)

        actions.append(record)

    summary = {
        "checkpoint": str(params_path),
        "env": env_name,
        "actions": actions,
        "n_pass": sum(1 for a in actions if a["passed"]),
        "all_pass": all(a["passed"] for a in actions),
    }
    if out is not None:
        (out / "multi_action_eval.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def _print_table(summary: dict) -> None:
    print(f"checkpoint: {summary['checkpoint']}  env: {summary['env']}")
    header = (
        f"  {'action':13s} {'text':18s} {'dx':>7s} {'dy':>7s} "
        f"{'cum_yaw':>8s} {'sw':>3s} {'min_z':>6s} {'fell':>5s}  PASS"
    )
    print(header)
    for a in summary["actions"]:
        print(
            f"  {a['action']:13s} {a['text']:18s} {a['dx']:+7.2f} {a['dy']:+7.2f} "
            f"{a['cum_yaw_rad']:+8.2f} {a['switches']:3d} {a['min_base_z']:6.2f} "
            f"{str(a['fell']):>5s}  {'PASS' if a['passed'] else 'FAIL'} "
            f"{a['fail_reasons'] if a['fail_reasons'] else ''}"
        )
    print(f"\n{summary['n_pass']}/{len(summary['actions'])} actions pass. all_pass={summary['all_pass']}")


def main(argv: list[str] | None = None) -> int:
    import os

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env", default="H1JoystickGaitTracking")
    p.add_argument("--ckpt", required=True, help="path to final_params (or a params file)")
    p.add_argument("--eval-steps", type=int, default=350)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--render", action="store_true")
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args(argv)

    summary = evaluate_all_actions(
        args.env,
        args.ckpt,
        eval_steps=args.eval_steps,
        seed=args.seed,
        render=args.render,
        out_dir=args.out,
    )
    _print_table(summary)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
