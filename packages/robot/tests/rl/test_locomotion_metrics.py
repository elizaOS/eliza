"""Tests for the honest bipedal-locomotion metric.

These lock in the property the old video gate lacked: a robot that stays
upright but does NOT translate forward must FAIL the walk check, and only a
trajectory that actually moves forward at roughly the commanded speed with
alternating foot contacts passes.
"""

from __future__ import annotations

import numpy as np

from eliza_robot.rl.locomotion_metrics import (
    count_contact_switches,
    evaluate_walk_trajectory,
)


def _alternating_contacts(n: int) -> tuple[np.ndarray, np.ndarray]:
    """Synthesize an alternating single-support gait stream of length n."""
    left = np.zeros(n, dtype=bool)
    right = np.zeros(n, dtype=bool)
    period = 20
    for i in range(n):
        phase = (i // (period // 2)) % 2
        left[i] = phase == 0
        right[i] = phase == 1
    return left, right


def test_standing_still_fails_walk_gate():
    # Upright, stable height, zero displacement — the classic LARP "good".
    n = 200
    base = np.tile([0.0, 0.0, 1.0], (n, 1)).astype(float)
    m = evaluate_walk_trajectory(base, commanded_velocity_m_s=1.0, dt_s=0.02)
    assert not m.walk_forward_pass
    assert any("forward_disp" in r for r in m.fail_reasons)
    assert m.mean_forward_velocity_m_s == 0.0


def test_forward_walk_passes_walk_gate():
    n = 200
    dt = 0.02
    # ~1.0 m/s forward for 4s -> ~4 m, constant upright height.
    xs = np.linspace(0.0, 1.0 * n * dt, n)
    base = np.stack([xs, np.zeros(n), np.full(n, 1.0)], axis=1)
    left, right = _alternating_contacts(n)
    m = evaluate_walk_trajectory(
        base,
        commanded_velocity_m_s=1.0,
        dt_s=dt,
        left_contact=left,
        right_contact=right,
    )
    assert m.walk_forward_pass, m.fail_reasons
    assert m.mean_forward_velocity_m_s > 0.9
    assert m.foot_contact_switches >= 2


def test_fall_fails_even_if_it_moved():
    n = 50
    dt = 0.02
    xs = np.linspace(0.0, 2.0, n)
    base = np.stack([xs, np.zeros(n), np.full(n, 1.0)], axis=1)
    m = evaluate_walk_trajectory(base, commanded_velocity_m_s=1.0, dt_s=dt, fell=True)
    assert not m.walk_forward_pass
    assert "fell" in m.fail_reasons


def test_low_base_height_fails():
    # Dragged forward on the floor (height collapsed) is not walking.
    n = 200
    dt = 0.02
    xs = np.linspace(0.0, 4.0, n)
    base = np.stack([xs, np.zeros(n), np.full(n, 0.2)], axis=1)
    m = evaluate_walk_trajectory(base, commanded_velocity_m_s=1.0, dt_s=dt)
    assert not m.walk_forward_pass
    assert any("min_base_height" in r for r in m.fail_reasons)


def test_sideways_drift_fails_forward_command():
    n = 200
    dt = 0.02
    ys = np.linspace(0.0, 3.0, n)  # all motion is lateral
    base = np.stack([np.zeros(n), ys, np.full(n, 1.0)], axis=1)
    m = evaluate_walk_trajectory(base, commanded_velocity_m_s=1.0, dt_s=dt)
    assert not m.walk_forward_pass
    assert any("forward_disp" in r for r in m.fail_reasons)
    assert any("lateral_drift" in r for r in m.fail_reasons)


def test_contact_switch_counting():
    left, right = _alternating_contacts(80)
    # 80 steps, period 20 -> ~ 3 alternations
    assert count_contact_switches(left, right) >= 2
    # never lifting a foot (always double support) -> zero switches
    both = np.ones(80, dtype=bool)
    assert count_contact_switches(both, both) == 0


def test_heading_axis_backward():
    n = 100
    dt = 0.02
    xs = np.linspace(0.0, -2.0, n)  # moving in -x
    base = np.stack([xs, np.zeros(n), np.full(n, 1.0)], axis=1)
    m = evaluate_walk_trajectory(
        base, commanded_velocity_m_s=0.5, dt_s=dt, heading="x-"
    )
    assert m.mean_forward_velocity_m_s > 0  # forward in the commanded -x frame
    assert m.walk_forward_pass, m.fail_reasons
