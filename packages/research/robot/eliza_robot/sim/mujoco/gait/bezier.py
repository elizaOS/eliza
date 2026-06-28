"""Core Bezier gait math (pure numpy).

Ported verbatim — modulo type hints and minor cleanup — from
``GAIT_SOURCE_CODE.py`` in the upstream Hiwonder AiNex workspace. The
math itself is the same custom cubic-Bezier foot-height trajectory used
by the MuJoCo Playground locomotion environments.

References:
    * Berkeley Humanoid / H1 locomotion paper — https://arxiv.org/pdf/2201.00206
    * mujoco_mpc quadruped task — https://github.com/google-deepmind/mujoco_mpc/blob/main/mjpc/tasks/quadruped/quadruped.h
"""

from __future__ import annotations

from typing import Union

import numpy as np

Number = Union[np.ndarray, float]


def cubic_bezier_interpolation(y_start: Number, y_end: Number, x: Number) -> np.ndarray:
    """Smooth S-curve interpolation between two values.

    Not a standard cubic Bezier — this is the custom form used by the
    Berkeley Humanoid / Playground gait reward:

        y = y_start + (y_end - y_start) * (x**3 + 3 * x**2 * (1 - x))

    The resulting curve has zero first derivative at both endpoints,
    which produces the slow-start / fast-middle / slow-end profile that
    makes foot-height trajectories look like natural walking.

    Args:
        y_start: Starting value.
        y_end:   Ending value.
        x:       Parameter in [0, 1].

    Returns:
        Interpolated value(s); broadcasts over ``x``.
    """
    y_diff = y_end - y_start
    bezier = x ** 3 + 3 * (x ** 2 * (1 - x))
    return y_start + y_diff * bezier


def get_rz(phi: Number, swing_height: Number = 0.08) -> np.ndarray:
    """Desired foot Z-position (height) over the gait cycle.

    For each foot we maintain a phase ``phi`` in ``[-pi, pi]``. The full
    cycle is split into two halves: a stance half (foot rising from the
    ground up to ``swing_height``) and a swing half (foot falling back to
    the ground). Each half uses the cubic-Bezier S-curve above.

    Args:
        phi:          Phase angle in radians, typically ``[-pi, pi]``.
        swing_height: Maximum foot lift during swing (meters). Typical
                      values are in the range 0.05–0.4 m.

    Returns:
        Desired foot Z (height) in meters; broadcasts over ``phi``.

    References:
        * https://arxiv.org/pdf/2201.00206 (Berkeley humanoid)
        * https://github.com/google-deepmind/mujoco_mpc/blob/main/mjpc/tasks/quadruped/quadruped.h
    """
    # Normalize phase from [-pi, pi] to [0, 1].
    x = (phi + np.pi) / (2 * np.pi)

    # Stance half (x in [0, 0.5]): foot rises 0 -> swing_height.
    stance = cubic_bezier_interpolation(0.0, swing_height, 2 * x)

    # Swing half (x in [0.5, 1]): foot falls swing_height -> 0.
    swing = cubic_bezier_interpolation(swing_height, 0.0, 2 * x - 1)

    return np.where(x <= 0.5, stance, swing)


def initialize_gait_phase(
    rng: np.random.Generator,
    dt: float,
    gait_frequency_range: tuple[float, float] = (1.0, 1.5),
    foot_height_range: tuple[float, float] = (0.08, 0.15),
) -> dict[str, np.ndarray | float]:
    """Sample per-episode gait parameters.

    Args:
        rng: NumPy random generator.
        dt:  Control timestep in seconds (e.g. 0.02 for 50 Hz).
        gait_frequency_range: ``(min_hz, max_hz)`` bounds for gait frequency.
        foot_height_range:    ``(min_m, max_m)`` bounds for foot swing height.

    Returns:
        Dict with ``phase`` (shape ``[n_feet]``), ``phase_dt`` (radians per
        step), ``gait_freq`` (Hz) and ``foot_height`` (m).
    """
    gait_freq = float(rng.uniform(low=gait_frequency_range[0], high=gait_frequency_range[1]))
    phase_dt = 2 * np.pi * dt * gait_freq
    foot_height = float(rng.uniform(low=foot_height_range[0], high=foot_height_range[1]))

    # Bipedal: left and right feet are 180 degrees out of phase.
    phase = np.array([0.0, np.pi], dtype=np.float64)

    return {
        "phase": phase,
        "phase_dt": phase_dt,
        "gait_freq": gait_freq,
        "foot_height": foot_height,
    }


def advance_gait_phase(phase: np.ndarray, phase_dt: float | np.ndarray) -> np.ndarray:
    """Advance phase by one control step and wrap back into ``[-pi, pi]``.

    Args:
        phase:    Current phase for each foot.
        phase_dt: Phase increment in radians.

    Returns:
        Updated phase array, guaranteed to lie in ``[-pi, pi]``.
    """
    phase_tp1 = phase + phase_dt
    return np.fmod(phase_tp1 + np.pi, 2 * np.pi) - np.pi
