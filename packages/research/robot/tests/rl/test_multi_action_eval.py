"""Tests for the text-conditioned multi-action evaluator.

The fast tests pin the per-action honest gate (:func:`grade_action`) against
synthetic kinematics: every action type has a clear pass case and a clear fail
case, and the shared upright requirement (no fall, min base height) is enforced
for all of them. They never load JAX or a checkpoint.

One opt-in ``@pytest.mark.slow`` integration test runs the full evaluator on a
trained checkpoint (gated on ``ROBOT_WALK_CKPT``) and asserts every canonical
action passes; it SKIPS with an explicit reason when no checkpoint is provided.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from eliza_robot.rl.multi_action_eval import (
    CANONICAL_ACTIONS,
    evaluate_all_actions,
    grade_action,
)

PKG_ROOT = Path(__file__).resolve().parents[2]


# --- forward ---------------------------------------------------------------


def test_forward_pass():
    passed, reasons = grade_action(
        "forward", dx=1.2, dy=0.1, cum_yaw=0.0, switches=4, min_base_z=0.95, fell=False
    )
    assert passed, reasons


def test_forward_fail_no_displacement():
    passed, reasons = grade_action(
        "forward", dx=0.1, dy=0.0, cum_yaw=0.0, switches=4, min_base_z=0.95, fell=False
    )
    assert not passed
    assert any("dx" in r for r in reasons)


def test_forward_fail_no_gait():
    passed, reasons = grade_action(
        "forward", dx=1.2, dy=0.0, cum_yaw=0.0, switches=0, min_base_z=0.95, fell=False
    )
    assert not passed
    assert any("switches" in r for r in reasons)


# --- backward --------------------------------------------------------------


def test_backward_pass():
    passed, reasons = grade_action(
        "backward", dx=-1.0, dy=0.1, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert passed, reasons


def test_backward_fail_moved_forward():
    passed, reasons = grade_action(
        "backward", dx=0.8, dy=0.0, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("dx" in r for r in reasons)


# --- turn_left / turn_right ------------------------------------------------


def test_turn_left_pass():
    passed, reasons = grade_action(
        "turn_left", dx=0.2, dy=0.1, cum_yaw=1.0, switches=0, min_base_z=0.9, fell=False
    )
    assert passed, reasons


def test_turn_left_fail_insufficient_yaw():
    passed, reasons = grade_action(
        "turn_left", dx=0.0, dy=0.0, cum_yaw=0.1, switches=0, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("cum_yaw" in r for r in reasons)


def test_turn_left_fail_drift():
    passed, reasons = grade_action(
        "turn_left", dx=1.5, dy=0.0, cum_yaw=1.0, switches=0, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("drift" in r for r in reasons)


def test_turn_right_pass():
    passed, reasons = grade_action(
        "turn_right", dx=0.1, dy=0.2, cum_yaw=-1.0, switches=0, min_base_z=0.9, fell=False
    )
    assert passed, reasons


def test_turn_right_fail_wrong_sign():
    # A leftward yaw must fail a turn-right command.
    passed, reasons = grade_action(
        "turn_right", dx=0.0, dy=0.0, cum_yaw=1.0, switches=0, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("cum_yaw" in r for r in reasons)


# --- strafe_left / strafe_right --------------------------------------------


def test_strafe_left_pass():
    passed, reasons = grade_action(
        "strafe_left", dx=0.0, dy=0.5, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert passed, reasons


def test_strafe_left_fail_no_lateral():
    passed, reasons = grade_action(
        "strafe_left", dx=0.0, dy=0.05, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("dy" in r for r in reasons)


def test_strafe_right_pass():
    passed, reasons = grade_action(
        "strafe_right", dx=0.0, dy=-0.5, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert passed, reasons


def test_strafe_right_fail_wrong_sign():
    passed, reasons = grade_action(
        "strafe_right", dx=0.0, dy=0.5, cum_yaw=0.0, switches=3, min_base_z=0.9, fell=False
    )
    assert not passed
    assert any("dy" in r for r in reasons)


# --- stand -----------------------------------------------------------------


def test_stand_still_passes():
    passed, reasons = grade_action(
        "stand", dx=0.0, dy=0.0, cum_yaw=0.0, switches=0, min_base_z=0.97, fell=False
    )
    assert passed, reasons


def test_stand_with_drift_fails():
    # Standing still must not wander 2m.
    passed, reasons = grade_action(
        "stand", dx=2.0, dy=0.0, cum_yaw=0.0, switches=0, min_base_z=0.97, fell=False
    )
    assert not passed
    assert any("moved" in r for r in reasons)


def test_stand_with_spin_fails():
    passed, reasons = grade_action(
        "stand", dx=0.0, dy=0.0, cum_yaw=1.5, switches=0, min_base_z=0.97, fell=False
    )
    assert not passed
    assert any("spun" in r for r in reasons)


# --- shared upright requirement (every action) -----------------------------


@pytest.mark.parametrize("_text,action_type", CANONICAL_ACTIONS)
def test_fall_fails_every_action(_text: str, action_type: str):
    # A fall fails regardless of how good the displacement looks.
    passed, reasons = grade_action(
        action_type, dx=1.0, dy=-0.6, cum_yaw=-1.0, switches=4, min_base_z=0.95, fell=True
    )
    assert not passed
    assert "fell" in reasons


@pytest.mark.parametrize("_text,action_type", CANONICAL_ACTIONS)
def test_collapsed_base_fails_every_action(_text: str, action_type: str):
    # A crouched/collapsed base (below the upright floor) fails every action.
    passed, reasons = grade_action(
        action_type, dx=1.0, dy=-0.6, cum_yaw=-1.0, switches=4, min_base_z=0.4, fell=False
    )
    assert not passed
    assert any("min_base_z" in r for r in reasons)


def test_unknown_action_raises():
    with pytest.raises(ValueError):
        grade_action(
            "moonwalk", dx=0.0, dy=0.0, cum_yaw=0.0, switches=0, min_base_z=0.9, fell=False
        )


# --- opt-in integration test -----------------------------------------------


def _resolve_params() -> Path | None:
    env = os.environ.get("ROBOT_WALK_CKPT")
    if not env:
        return None
    p = Path(env)
    if not p.is_absolute():
        p = PKG_ROOT / p
    if p.is_file():
        return p
    if (p / "final_params").exists():
        return p / "final_params"
    return None


@pytest.mark.slow
def test_evaluate_all_actions_on_trained_checkpoint():
    """Full text -> velocity -> single RL policy -> per-action honest gate.

    Runs the canonical 7 actions on a converged checkpoint and asserts every one
    passes its direction-appropriate gate. Skips (never silently passes) when no
    checkpoint is provided via ROBOT_WALK_CKPT.
    """
    pytest.importorskip("jax")
    pytest.importorskip("mujoco_playground")

    params = _resolve_params()
    if params is None:
        pytest.skip(
            "no trained checkpoint provided (set ROBOT_WALK_CKPT to a dir with "
            "final_params or a params file). This benchmark runs post-merge "
            "against a converged omnidirectional checkpoint."
        )

    os.environ.setdefault("JAX_PLATFORMS", "cpu")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    env_name = os.environ.get("ROBOT_WALK_ENV", "H1JoystickGaitTracking")

    summary = evaluate_all_actions(env_name, params, eval_steps=350, seed=1)

    assert len(summary["actions"]) == len(CANONICAL_ACTIONS)
    failed = [a for a in summary["actions"] if not a["passed"]]
    assert summary["all_pass"], f"actions failed: {[(a['action'], a['fail_reasons']) for a in failed]}"
