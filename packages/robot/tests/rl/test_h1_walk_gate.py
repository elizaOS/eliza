"""Integration walk-gate benchmark: does the TRAINED policy actually walk?

`test_locomotion_metrics.py` locks in the pure honest metric on synthetic
trajectories. This module closes the remaining loop: it rolls out a real
trained mujoco_playground locomotion checkpoint via
``eliza_robot.rl.walk_proof`` (which reads REAL per-foot floor-contact
sensors, not the always-[1,1] ``info["last_contact"]`` field) and asserts it
passes the same honest gate — net forward displacement at ~commanded speed,
alternating foot contacts, upright, no fall.

It is an opt-in benchmark, not a unit test: it needs a converged checkpoint
(minutes on GPU / ~hours on CPU to produce) and the JAX/MJX stack. Point it
at one with::

    ROBOT_WALK_CKPT=checkpoints/h1_walk \
    ROBOT_WALK_ENV=H1JoystickGaitTracking \
    uv run pytest tests/rl/test_h1_walk_gate.py -q

Without ROBOT_WALK_CKPT it SKIPS with an explicit reason (it never silently
passes — that was the original sin this whole effort is correcting). The
checkpoint may be either a directory containing ``final_params`` or a direct
path to a params file.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

PKG_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CKPT_CANDIDATES = (
    "checkpoints/h1_walk",
    "checkpoints/playground_walk",
)


def _resolve_params() -> Path | None:
    """Resolve a params file from ROBOT_WALK_CKPT or default candidates."""
    env = os.environ.get("ROBOT_WALK_CKPT")
    candidates = [env] if env else list(DEFAULT_CKPT_CANDIDATES)
    for cand in candidates:
        if not cand:
            continue
        p = Path(cand)
        if not p.is_absolute():
            p = PKG_ROOT / p
        if p.is_file():
            return p
        if (p / "final_params").exists():
            return p / "final_params"
    return None


@pytest.mark.slow
def test_trained_policy_passes_honest_walk_gate():
    pytest.importorskip("jax")
    pytest.importorskip("mujoco_playground")

    params = _resolve_params()
    if params is None:
        pytest.skip(
            "no trained walk checkpoint found (set ROBOT_WALK_CKPT to a dir "
            "with final_params or a params file). This benchmark runs "
            "post-merge against a converged checkpoint."
        )

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    env_name = os.environ.get("ROBOT_WALK_ENV", "H1JoystickGaitTracking")

    from eliza_robot.rl.walk_proof import rollout_and_grade

    metrics, _, report = rollout_and_grade(
        env_name, params, command=(1.0, 0.0, 0.0), eval_steps=500, seed=0
    )

    # A standing / fallen / dragged / one-legged policy cannot pass this.
    assert not metrics.fell, f"policy fell: {metrics.fail_reasons}"
    assert metrics.delta_x_m >= 0.5, (
        f"insufficient forward displacement {metrics.delta_x_m:.3f}m "
        f"(reasons: {metrics.fail_reasons})"
    )
    assert metrics.foot_contact_switches >= 2, (
        f"no alternating gait: {metrics.foot_contact_switches} contact switches"
    )
    assert metrics.walk_forward_pass, f"walk gate failed: {metrics.fail_reasons}"


@pytest.mark.slow
def test_text_command_drives_trained_policy_to_walk():
    """Full LLM-action -> RL bridge: a free-form text instruction is parsed to
    a velocity command and the trained policy walks forward under it."""
    pytest.importorskip("jax")
    pytest.importorskip("mujoco_playground")

    params = _resolve_params()
    if params is None:
        pytest.skip(
            "no trained walk checkpoint found (set ROBOT_WALK_CKPT). Runs "
            "post-merge against a converged checkpoint."
        )

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    env_name = os.environ.get("ROBOT_WALK_ENV", "H1JoystickGaitTracking")

    from eliza_robot.rl.meta.locomotion_command import velocity_from_text
    from eliza_robot.rl.walk_proof import rollout_and_grade

    cmd = velocity_from_text("walk forward fast")
    assert cmd.vx > 0  # the bridge produced a forward command from text

    metrics, _, _ = rollout_and_grade(
        env_name, params, command=cmd.as_tuple(), eval_steps=500, seed=0
    )
    assert metrics.walk_forward_pass, (
        f"text->command->policy did not walk: {metrics.fail_reasons}"
    )
