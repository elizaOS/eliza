"""Tests for sim2real calibration parameters + trajectory distance.

These modules (calibration.py, sysid.py) previously had zero coverage. This
locks in two audit fixes: apply_to must only calibrate commanded joints, and
the empty-trajectory distance must include rms_total (callers index it).
"""

from __future__ import annotations

import numpy as np

from eliza_robot.sim2real.calibration import (
    CalibrationParameters,
    TrajectoryRecord,
    _trajectory_distance,
)


def test_apply_to_full_command_applies_strength_and_offset():
    order = ["j0", "j1", "j2"]
    params = CalibrationParameters(
        motor_strengths=np.array([1.0, 2.0, 0.5], dtype=np.float32),
        joint_offsets=np.array([0.0, 0.1, -0.2], dtype=np.float32),
    )
    out = params.apply_to({"j0": 1.0, "j1": 1.0, "j2": 1.0}, order)
    assert out["j0"] == 1.0
    assert abs(out["j1"] - 2.1) < 1e-6
    assert abs(out["j2"] - 0.3) < 1e-6


def test_apply_to_only_returns_commanded_joints():
    order = ["j0", "j1", "j2"]
    params = CalibrationParameters(
        motor_strengths=np.ones(3, dtype=np.float32),
        joint_offsets=np.array([0.5, 0.5, 0.5], dtype=np.float32),
    )
    # Only j1 commanded — j0/j2 must NOT be driven (no fabricated 0.0+offset).
    out = params.apply_to({"j1": 1.0}, order)
    assert set(out) == {"j1"}
    assert abs(out["j1"] - 1.5) < 1e-6


def test_apply_to_preserves_offset_index_alignment():
    order = ["a", "b", "c", "d"]
    params = CalibrationParameters(
        motor_strengths=np.ones(4, dtype=np.float32),
        joint_offsets=np.array([0.0, 0.0, 0.0, 0.9], dtype=np.float32),
    )
    # Command only the 4th joint: its offset (index 3) must still be used.
    out = params.apply_to({"d": 0.0}, order)
    assert abs(out["d"] - 0.9) < 1e-6


def _rec(t, roll, pitch, jp):
    return TrajectoryRecord(t_s=t, imu_roll=roll, imu_pitch=pitch, joint_positions=jp)


def test_trajectory_distance_empty_has_rms_total():
    d = _trajectory_distance([], [])
    assert d["samples"] == 0
    assert d["rms_imu"] == 0.0
    assert d["rms_joint"] == 0.0
    assert d["rms_total"] == 0.0  # regression: was missing -> caller KeyError


def test_trajectory_distance_identical_is_zero():
    a = [_rec(0.0, 0.1, 0.2, {"j0": 1.0}), _rec(0.1, 0.1, 0.2, {"j0": 1.0})]
    d = _trajectory_distance(a, a)
    assert d["samples"] == 2
    assert d["rms_imu"] < 1e-9
    assert d["rms_joint"] < 1e-9
    assert d["rms_total"] < 1e-9


def test_trajectory_distance_detects_divergence():
    a = [_rec(0.0, 0.0, 0.0, {"j0": 0.0})]
    b = [_rec(0.0, 0.5, 0.0, {"j0": 1.0})]
    d = _trajectory_distance(a, b)
    assert d["rms_imu"] > 0.0
    assert d["rms_joint"] > 0.0
    assert d["rms_total"] >= max(d["rms_imu"], d["rms_joint"])
