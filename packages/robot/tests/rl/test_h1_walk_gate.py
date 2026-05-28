"""Integration walk-gate benchmark: does the TRAINED policy actually walk?

`test_locomotion_metrics.py` locks in the pure honest metric on synthetic
trajectories. This module closes the remaining loop: it rolls out a real
trained mujoco_playground locomotion checkpoint and asserts it passes the
same honest gate (net forward displacement at ~commanded speed, alternating
foot contacts, upright, no fall).

It is an opt-in benchmark, not a unit test: it needs a converged checkpoint
(minutes on GPU / ~hours on CPU to produce) and the JAX/MJX stack. Point it
at one with::

    ROBOT_WALK_CKPT=checkpoints/h1_walk \
    ROBOT_WALK_ENV=H1JoystickGaitTracking \
    uv run pytest tests/rl/test_h1_walk_gate.py -q

Without ROBOT_WALK_CKPT it SKIPS with an explicit reason (it never silently
passes — that was the original sin this whole effort is correcting).
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

PKG_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CKPT_CANDIDATES = (
    "checkpoints/h1_walk",
    "checkpoints/playground_walk",
)


def _resolve_checkpoint() -> Path | None:
    env = os.environ.get("ROBOT_WALK_CKPT")
    candidates = [env] if env else list(DEFAULT_CKPT_CANDIDATES)
    for cand in candidates:
        if not cand:
            continue
        p = Path(cand)
        if not p.is_absolute():
            p = PKG_ROOT / p
        if (p / "final_params").exists():
            return p
    return None


def _load_eval_module():
    spec = importlib.util.spec_from_file_location(
        "_train_playground_locomotion",
        PKG_ROOT / "scripts" / "train_playground_locomotion.py",
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.slow
def test_trained_policy_passes_honest_walk_gate():
    pytest.importorskip("jax")
    pytest.importorskip("mujoco_playground")

    ckpt = _resolve_checkpoint()
    if ckpt is None:
        pytest.skip(
            "no trained walk checkpoint found (set ROBOT_WALK_CKPT to a dir "
            "containing final_params, e.g. checkpoints/h1_walk). This benchmark "
            "is run post-merge against a converged checkpoint."
        )

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    env_name = os.environ.get("ROBOT_WALK_ENV", "H1JoystickGaitTracking")

    mod = _load_eval_module()
    report = mod.evaluate_and_render(
        env_name,
        ckpt / "final_params",
        command=(1.0, 0.0, 0.0),
        eval_steps=500,
        seed=0,
        render=False,
        out_dir=ckpt,
    )

    # The honest gate — identical criteria to locomotion_metrics, applied to a
    # real rollout. A standing / fallen / dragged policy cannot pass this.
    assert not report["fell"], f"policy fell: {report.get('fail_reasons')}"
    assert report["delta_x_m"] >= 0.5, (
        f"insufficient forward displacement {report['delta_x_m']:.3f}m "
        f"(reasons: {report.get('fail_reasons')})"
    )
    assert report["foot_contact_switches"] >= 2, (
        f"no alternating gait: {report['foot_contact_switches']} contact switches"
    )
    assert report["walk_forward_pass"], f"walk gate failed: {report['fail_reasons']}"


@pytest.mark.slow
def test_text_command_drives_trained_policy_to_walk():
    """Full LLM-action -> RL bridge: a free-form text instruction is parsed to
    a velocity command and the trained policy walks forward under it."""
    pytest.importorskip("jax")
    pytest.importorskip("mujoco_playground")

    ckpt = _resolve_checkpoint()
    if ckpt is None:
        pytest.skip(
            "no trained walk checkpoint found (set ROBOT_WALK_CKPT). This "
            "benchmark is run post-merge against a converged checkpoint."
        )

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    env_name = os.environ.get("ROBOT_WALK_ENV", "H1JoystickGaitTracking")

    from eliza_robot.rl.meta.locomotion_command import velocity_from_text

    cmd = velocity_from_text("walk forward fast")
    assert cmd.vx > 0  # the bridge produced a forward command from text

    mod = _load_eval_module()
    report = mod.evaluate_and_render(
        env_name,
        ckpt / "final_params",
        command=cmd.as_tuple(),
        eval_steps=500,
        seed=0,
        render=False,
        out_dir=ckpt,
    )
    assert report["walk_forward_pass"], (
        f"text->command->policy did not walk: {report['fail_reasons']}"
    )
