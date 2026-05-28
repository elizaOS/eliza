"""Honest bipedal-locomotion metrics.

The robot-video "evidence" pipeline historically graded a walk clip "good"
when the robot merely *stayed upright* — pixel frame-delta with a
``min_visual_progress=0.0`` threshold, plus a telemetry check that only
asserted ``torso_z`` stayed above the fall line. A robot standing perfectly
still passes all of that. It proves nothing about walking.

This module is the single honest primitive: given a base-link trajectory
(and optional foot-contact stream), it measures whether the robot actually
*translated* in the commanded direction at roughly the commanded speed, with
alternating foot contacts, while staying upright. ``walk_forward_pass`` is
True only when real locomotion happened.

It is pure (numpy only, no sim/jax) so it is cheap to unit-test against
synthetic trajectories and reusable by training eval, the video gate, and
the bridge.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np


@dataclass(frozen=True)
class WalkMetrics:
    steps: int
    elapsed_s: float
    delta_x_m: float
    delta_y_m: float
    distance_m: float
    mean_forward_velocity_m_s: float
    commanded_velocity_m_s: float
    velocity_tracking_abs_err_m_s: float
    min_base_height_m: float
    mean_base_height_m: float
    lateral_drift_m: float
    foot_contact_switches: int
    fell: bool
    walk_forward_pass: bool
    fail_reasons: tuple[str, ...]

    def to_dict(self) -> dict:
        return asdict(self)


def count_contact_switches(
    left_contact: np.ndarray, right_contact: np.ndarray
) -> int:
    """Number of times single-support switches from one foot to the other.

    A genuine biped gait alternates left/right single support. Double
    support and flight phases are ignored; only transitions between
    *left-only* and *right-only* stance are counted, which is the signal a
    standing or hopping robot cannot fake.
    """
    left = np.asarray(left_contact).astype(bool)
    right = np.asarray(right_contact).astype(bool)
    n = min(len(left), len(right))
    switches = 0
    last_single: str | None = None
    for i in range(n):
        l, r = bool(left[i]), bool(right[i])
        if l == r:  # double support or flight — not a single-stance state
            continue
        state = "left" if l else "right"
        if last_single is not None and state != last_single:
            switches += 1
        last_single = state
    return switches


def evaluate_walk_trajectory(
    base_xyz: np.ndarray,
    *,
    commanded_velocity_m_s: float,
    dt_s: float,
    fell: bool = False,
    left_contact: np.ndarray | None = None,
    right_contact: np.ndarray | None = None,
    min_forward_distance_m: float = 0.5,
    min_velocity_tracking_ratio: float = 0.3,
    max_lateral_drift_m: float = 0.5,
    min_base_height_m: float = 0.5,
    min_contact_switches: int = 2,
    heading: str = "x+",
) -> WalkMetrics:
    """Grade a base-link trajectory for honest forward locomotion.

    Args:
        base_xyz: ``(T, 3)`` world positions of the base/torso over the rollout.
        commanded_velocity_m_s: forward speed the policy was told to track.
        dt_s: control timestep.
        fell: whether the episode terminated early (a fall).
        left_contact / right_contact: optional ``(T,)`` 0/1 foot-contact streams.
        min_forward_distance_m: minimum net displacement along the commanded
            forward axis to count as walking.
        min_velocity_tracking_ratio: realized mean forward velocity must be at
            least this fraction of the commanded velocity.
        max_lateral_drift_m: maximum |sideways| displacement allowed.
        min_base_height_m: the base must stay above this the whole rollout.
        min_contact_switches: minimum alternating single-stance transitions
            (only enforced when contact streams are provided).
        heading: forward axis, one of ``x+ x- y+ y-``.

    Returns a :class:`WalkMetrics` whose ``walk_forward_pass`` is True only if
    every locomotion criterion holds.
    """
    pts = np.asarray(base_xyz, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] < 3 or pts.shape[0] < 2:
        raise ValueError("base_xyz must be (T>=2, 3)")
    n = pts.shape[0] - 1
    elapsed_s = n * dt_s
    dx = float(pts[-1, 0] - pts[0, 0])
    dy = float(pts[-1, 1] - pts[0, 1])
    dz_series = pts[:, 2]

    axis_sign = {"x+": (0, 1.0), "x-": (0, -1.0), "y+": (1, 1.0), "y-": (1, -1.0)}
    if heading not in axis_sign:
        raise ValueError(f"heading must be one of {sorted(axis_sign)}")
    fwd_idx, sign = axis_sign[heading]
    lat_idx = 1 - fwd_idx
    forward_disp = sign * float(pts[-1, fwd_idx] - pts[0, fwd_idx])
    lateral_drift = abs(float(pts[-1, lat_idx] - pts[0, lat_idx]))
    mean_fwd_vel = forward_disp / elapsed_s if elapsed_s > 0 else 0.0

    switches = 0
    if left_contact is not None and right_contact is not None:
        switches = count_contact_switches(left_contact, right_contact)

    cmd = float(commanded_velocity_m_s)
    fail: list[str] = []
    if fell:
        fail.append("fell")
    if forward_disp < min_forward_distance_m:
        fail.append(
            f"forward_disp {forward_disp:.3f}m < {min_forward_distance_m}m"
        )
    if cmd > 0 and mean_fwd_vel < min_velocity_tracking_ratio * cmd:
        fail.append(
            f"mean_fwd_vel {mean_fwd_vel:.3f} < {min_velocity_tracking_ratio}*{cmd}"
        )
    if lateral_drift > max_lateral_drift_m:
        fail.append(f"lateral_drift {lateral_drift:.3f}m > {max_lateral_drift_m}m")
    if float(np.min(dz_series)) < min_base_height_m:
        fail.append(
            f"min_base_height {float(np.min(dz_series)):.3f}m < {min_base_height_m}m"
        )
    if (
        left_contact is not None
        and right_contact is not None
        and switches < min_contact_switches
    ):
        fail.append(f"contact_switches {switches} < {min_contact_switches}")

    return WalkMetrics(
        steps=n,
        elapsed_s=elapsed_s,
        delta_x_m=dx,
        delta_y_m=dy,
        distance_m=float(np.hypot(dx, dy)),
        mean_forward_velocity_m_s=mean_fwd_vel,
        commanded_velocity_m_s=cmd,
        velocity_tracking_abs_err_m_s=abs(mean_fwd_vel - cmd),
        min_base_height_m=float(np.min(dz_series)),
        mean_base_height_m=float(np.mean(dz_series)),
        lateral_drift_m=lateral_drift,
        foot_contact_switches=switches,
        fell=bool(fell),
        walk_forward_pass=(len(fail) == 0),
        fail_reasons=tuple(fail),
    )
