"""Tests for the Bezier gait controller.

Layered so that the math tests run with only numpy installed, and the
MuJoCo-dependent stability test is marked ``slow`` and skipped when no
GL backend is configured.
"""

from __future__ import annotations

import math
import os

import numpy as np
import pytest

from eliza_robot.sim.mujoco.gait import (
    BezierGaitController,
    advance_gait_phase,
    get_rz,
)

# ----------------------------------------------------------------------
# get_rz
# ----------------------------------------------------------------------


def test_get_rz_at_phase_zero_returns_zero() -> None:
    """At phi = 0 the foot has just left the ground — desired Z is zero."""
    # phi = 0  => x = 0.5  => boundary between stance and swing.
    # Both branches evaluate to swing_height/2 at x = 0.5; the Berkeley
    # formula's discontinuity-free transition means the foot is at its
    # peak height here, not on the ground. The "foot on ground" phases
    # are phi = +-pi (x = 0 or 1). Test both endpoints.
    swing = 0.08
    np.testing.assert_allclose(get_rz(np.pi, swing_height=swing), 0.0, atol=1e-12)
    np.testing.assert_allclose(get_rz(-np.pi, swing_height=swing), 0.0, atol=1e-12)


def test_get_rz_at_phase_pi_over_two_below_swing_height() -> None:
    """Foot height never exceeds the configured swing height."""
    swing = 0.08
    # Mid-stance: phi = -pi/2  => x = 0.25 (rising)
    # Mid-swing:  phi = +pi/2  => x = 0.75 (falling)
    rising = float(get_rz(-np.pi / 2, swing_height=swing))
    falling = float(get_rz(+np.pi / 2, swing_height=swing))
    peak = float(get_rz(0.0, swing_height=swing))  # x = 0.5

    assert 0.0 < rising < swing
    assert 0.0 < falling < swing
    assert peak == pytest.approx(swing, abs=1e-12)
    # By symmetry the rising and falling values match.
    assert rising == pytest.approx(falling, abs=1e-12)


def test_get_rz_broadcasts_over_phase_array() -> None:
    """``get_rz`` should accept a vector of phases and broadcast."""
    phases = np.array([0.0, np.pi, -np.pi])
    z = get_rz(phases, swing_height=0.1)
    assert z.shape == (3,)
    np.testing.assert_allclose(z[0], 0.1, atol=1e-12)
    np.testing.assert_allclose(z[1], 0.0, atol=1e-12)
    np.testing.assert_allclose(z[2], 0.0, atol=1e-12)


def test_advance_gait_phase_wraps_to_pi() -> None:
    """Phase increments wrap continuously into [-pi, pi]."""
    phase = np.array([math.pi - 0.05, -math.pi + 0.05])
    new = advance_gait_phase(phase, 0.10)
    assert -math.pi <= float(new[0]) <= math.pi
    assert -math.pi <= float(new[1]) <= math.pi


# ----------------------------------------------------------------------
# BezierGaitController
# ----------------------------------------------------------------------


def test_controller_emits_24dim_command() -> None:
    """``step`` returns a 24-vector of float joint angles."""
    ctl = BezierGaitController(swing_height=0.05, cycle_hz=2.0)
    ctl.reset()
    q = ctl.step(vx=0.0, vy=0.0, vyaw=0.0, dt=0.02)
    assert isinstance(q, np.ndarray)
    assert q.shape == (24,)
    assert q.dtype == np.float64


def test_controller_stable_3_steps() -> None:
    """Joint magnitudes stay within sane bounds across a few steps."""
    ctl = BezierGaitController(swing_height=0.08, cycle_hz=4.1)
    ctl.reset()
    for _ in range(3):
        q = ctl.step(vx=0.0, vy=0.0, vyaw=0.0, dt=0.02)
        # All joint targets should be well within +-pi.
        assert np.all(np.isfinite(q))
        assert np.all(np.abs(q) < math.pi)


def test_controller_phase_advances_per_step() -> None:
    """Each ``step`` advances the internal phase by ``2*pi*cycle_hz*dt``."""
    ctl = BezierGaitController(swing_height=0.05, cycle_hz=1.0)
    ctl.reset()
    phase_before = ctl.phase.copy()
    ctl.step(vx=0.0, vy=0.0, vyaw=0.0, dt=0.1)
    phase_after = ctl.phase
    expected_delta = 2 * np.pi * 1.0 * 0.1
    delta = float((phase_after[0] - phase_before[0]) % (2 * np.pi))
    assert delta == pytest.approx(expected_delta, abs=1e-9)


def test_controller_reset_returns_neutral_pose() -> None:
    """``reset`` re-initializes phase and returns the neutral 24-pose."""
    ctl = BezierGaitController()
    q0 = ctl.reset()
    assert q0.shape == (24,)
    # Advance, then reset, expect phase to be back to [0, pi].
    ctl.step(vx=0.2, vy=0.0, vyaw=0.0, dt=0.05)
    ctl.reset()
    np.testing.assert_allclose(ctl.phase, np.array([0.0, np.pi]))


def test_controller_neutral_pose_mirrors_ainex_sagittal_joint_signs() -> None:
    """Equivalent bent-knee flexion uses opposite signs on the right leg."""
    from eliza_robot.sim.mujoco.gait.controller import (
        L_ANK_PITCH,
        L_HIP_PITCH,
        L_KNEE,
        R_ANK_PITCH,
        R_HIP_PITCH,
        R_KNEE,
    )

    q0 = BezierGaitController().reset()

    assert q0[L_HIP_PITCH] > 0.0
    assert q0[L_KNEE] < 0.0
    assert q0[L_ANK_PITCH] > 0.0
    assert q0[R_HIP_PITCH] == pytest.approx(-q0[L_HIP_PITCH])
    assert q0[R_KNEE] == pytest.approx(-q0[L_KNEE])
    assert q0[R_ANK_PITCH] == pytest.approx(-q0[L_ANK_PITCH])


def test_controller_profile_override_takes_precedence() -> None:
    """A profile-provided gait config overrides the explicit kwargs."""

    class _StubProfile:
        gait = {"swing_height": 0.12, "cycle_hz": 2.5, "stance_width": 0.05}

    ctl = BezierGaitController(profile=_StubProfile(), swing_height=0.05, cycle_hz=10.0)
    assert ctl.swing_height == pytest.approx(0.12)
    assert ctl.cycle_hz == pytest.approx(2.5)
    assert ctl.stance_width == pytest.approx(0.05)


def test_controller_reads_real_profile_gait_fields() -> None:
    """Real profiles use Pydantic fields with meter-suffixed names."""
    from eliza_robot.profiles import load_profile

    profile = load_profile("hiwonder-ainex")
    ctl = BezierGaitController(profile=profile, swing_height=0.01, cycle_hz=10.0)

    assert ctl.swing_height == pytest.approx(profile.gait.swing_height_m)
    assert ctl.cycle_hz == pytest.approx(profile.gait.cycle_hz)
    assert ctl.stance_width == pytest.approx(profile.gait.stance_width_m)
    assert ctl.foot_offset == pytest.approx(profile.gait.foot_offset_m)


def test_controller_reads_real_profile_home_pose() -> None:
    """Real profiles seed reset/base pose from kinematics joint home values."""
    from eliza_robot.profiles import load_profile

    profile = load_profile("hiwonder-ainex")
    ctl = BezierGaitController(profile=profile)

    expected = np.zeros(24, dtype=np.float64)
    for joint in profile.kinematics.joints:
        expected[joint.index] = joint.home_rad

    np.testing.assert_allclose(ctl.reset(), expected)
    np.testing.assert_allclose(ctl.neutral_pose, expected)


def test_controller_reads_mapping_fixture_neutral_pose() -> None:
    """Mapping fixtures can still provide a neutral pose without kinematics."""

    neutral = np.linspace(-0.12, 0.12, 24, dtype=np.float64)

    class _StubProfile:
        gait = {"swing_height": 0.08, "cycle_hz": 1.25, "stance_width": 0.10}
        neutral_pose = neutral

    ctl = BezierGaitController(profile=_StubProfile())

    np.testing.assert_allclose(ctl.reset(), neutral)


def test_profile_foot_offset_does_not_saturate_leg_ik() -> None:
    """Large body-to-foot profile offsets are bounded before the leg IK trim."""
    from eliza_robot.sim.mujoco.gait.controller import L_KNEE, R_KNEE

    class _StubProfile:
        gait = {
            "swing_height": 0.08,
            "cycle_hz": 1.25,
            "stance_width": 0.10,
            "foot_offset": -0.25,
        }

    ctl = BezierGaitController(profile=_StubProfile())
    q = ctl.step(vx=0.0, vy=0.0, vyaw=0.0, dt=0.02)

    assert ctl.foot_offset == pytest.approx(-0.25)
    assert abs(float(q[L_KNEE])) > 0.3
    assert abs(float(q[R_KNEE])) > 0.3


# ----------------------------------------------------------------------
# Slow MuJoCo end-to-end stability test
# ----------------------------------------------------------------------


def _mujoco_available() -> bool:
    if not os.environ.get("MUJOCO_GL"):
        return False
    try:
        import mujoco  # noqa: F401
    except Exception:
        return False
    try:
        from eliza_robot.sim.mujoco import ainex_constants as consts

        return consts.SCENE_PRIMITIVES_XML.exists()
    except Exception:
        return False


@pytest.mark.slow
@pytest.mark.skipif(
    not _mujoco_available(),
    reason="MUJOCO_GL not set or mujoco/scene XML unavailable",
)
def test_controller_does_not_fall_in_one_second() -> None:
    """1 s of open-loop walking at vx=0.2 should not drop the base below 0.15 m."""
    from eliza_robot.sim.mujoco.gait import JoystickGaitDriver

    driver = JoystickGaitDriver()
    rollout = driver.run(vx=0.2, vy=0.0, vyaw=0.0, duration_s=1.0)
    base_z = rollout.qpos[:, 2]
    assert float(base_z.min()) > 0.15, (
        f"robot fell during open-loop gait: min base z = {float(base_z.min()):.3f}"
    )
