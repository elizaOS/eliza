"""Programmatic success checker for curriculum tasks.

Given a `TaskSpec` and a stream of telemetry samples (each sample is the
`data` payload of a `telemetry.basic` event plus optional ground-truth
state from the env), `GoalChecker` answers two questions in real time:

  - has the task failed irrecoverably yet? (e.g. fall pitch > limit)
  - has the task succeeded yet?            (predicate from spec.success)

These are the **same** checks the testbed uses for sim *and* real, so a
sim-trained policy is evaluated against the same criteria on hardware.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from eliza_robot.curriculum.loader import TaskSpec


@dataclass
class TelemetrySample:
    """One observation slice fed to the goal checker."""

    t_s: float
    torso_z_m: float | None = None
    torso_x_m: float | None = None
    torso_y_m: float | None = None
    yaw_rad: float | None = None
    imu_roll_rad: float = 0.0
    imu_pitch_rad: float = 0.0
    head_pan_rad: float = 0.0
    head_tilt_rad: float = 0.0
    walk_speed: int = 0
    is_walking: bool = False
    joint_positions: dict[str, float] = field(default_factory=dict)
    target_distance_m: float | None = None
    gripper_separation_m: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class GoalResult:
    success: bool = False
    failed: bool = False
    reason: str = ""
    elapsed_s: float = 0.0
    success_window_s: float = 0.0  # how long the success predicate has held


class GoalChecker:
    """Stateful per-episode goal evaluator for a single curriculum task."""

    def __init__(self, task: TaskSpec, episode_start_t_s: float = 0.0) -> None:
        self.task = task
        self.t0 = episode_start_t_s
        self.samples: list[TelemetrySample] = []
        self._success_hold_start_s: float | None = None
        self._init_x_m: float | None = None
        self._init_y_m: float | None = None
        self._init_yaw_rad: float | None = None
        self._init_torso_z_m: float | None = None
        # rolling extrema for oscillation tasks
        self._joint_history: dict[str, list[float]] = {}

    # ------------------------------------------------------------------
    def update(self, sample: TelemetrySample) -> GoalResult:
        self.samples.append(sample)
        if self._init_x_m is None and sample.torso_x_m is not None:
            self._init_x_m = sample.torso_x_m
        if self._init_y_m is None and sample.torso_y_m is not None:
            self._init_y_m = sample.torso_y_m
        if self._init_yaw_rad is None and sample.yaw_rad is not None:
            self._init_yaw_rad = sample.yaw_rad
        if self._init_torso_z_m is None and sample.torso_z_m is not None:
            self._init_torso_z_m = sample.torso_z_m
        for jname, jval in sample.joint_positions.items():
            self._joint_history.setdefault(jname, []).append(jval)

        elapsed = sample.t_s - self.t0
        result = GoalResult(elapsed_s=elapsed)

        # Universal fall check (every task fails if the robot falls).
        crit = self.task.success
        fall_pitch = float(crit.get("fall_pitch_rad", 0.6))
        fall_roll = float(crit.get("fall_roll_rad", 0.6))
        if abs(sample.imu_pitch_rad) > fall_pitch:
            result.failed = True
            result.reason = f"fall: |pitch|={abs(sample.imu_pitch_rad):.2f} > {fall_pitch}"
            return result
        if abs(sample.imu_roll_rad) > fall_roll and self.task.id != "lie_down":
            result.failed = True
            result.reason = f"fall: |roll|={abs(sample.imu_roll_rad):.2f} > {fall_roll}"
            return result
        if elapsed > self.task.max_episode_s + 0.5:
            result.failed = True
            result.reason = f"timeout: {elapsed:.2f}s > max={self.task.max_episode_s}s"
            return result

        # Task-specific success predicates.
        ok, hold_window_s, why = self._check_success(sample, elapsed)
        if ok:
            if self._success_hold_start_s is None:
                self._success_hold_start_s = elapsed
            result.success_window_s = elapsed - self._success_hold_start_s
            if result.success_window_s >= hold_window_s:
                result.success = True
                result.reason = why
        else:
            self._success_hold_start_s = None
        return result

    # ------------------------------------------------------------------
    def _check_success(
        self, sample: TelemetrySample, elapsed: float
    ) -> tuple[bool, float, str]:
        """Returns (predicate-currently-holds, hold-window-required, reason)."""
        crit = self.task.success
        hold = float(crit.get("hold_s", 0.0))
        matched = False
        reasons: list[str] = []
        stand_height_raw = sample.extra.get("stand_height_m")
        stand_height_m = float(stand_height_raw) if stand_height_raw is not None else None

        def fail() -> tuple[bool, float, str]:
            return False, hold, ""

        # All declared predicates are conjunctive. Height alone must not pass
        # walking, waving, or squatting tasks that also declare motion criteria.
        if (
            "torso_z_min_m" in crit
            or "torso_z_max_m" in crit
            or "torso_z_min_ratio" in crit
            or "torso_z_max_ratio" in crit
            or "torso_z_delta_min_m" in crit
            or "torso_z_delta_min_ratio" in crit
        ):
            matched = True
            if sample.torso_z_m is None:
                return fail()
            lo = float(crit.get("torso_z_min_m", -math.inf))
            hi = float(crit.get("torso_z_max_m", math.inf))
            if "torso_z_min_ratio" in crit:
                if stand_height_m is None:
                    return fail()
                lo = max(lo, stand_height_m * float(crit["torso_z_min_ratio"]))
            if "torso_z_max_ratio" in crit:
                if stand_height_m is None:
                    return fail()
                hi = min(hi, stand_height_m * float(crit["torso_z_max_ratio"]))
            if not lo <= sample.torso_z_m <= hi:
                return fail()
            reasons.append(f"torso_z={sample.torso_z_m:.3f}m in [{lo:.3f}, {hi:.3f}]")
            delta_min = float(crit.get("torso_z_delta_min_m", 0.0))
            if "torso_z_delta_min_ratio" in crit:
                if stand_height_m is None:
                    return fail()
                delta_min = max(
                    delta_min,
                    stand_height_m * float(crit["torso_z_delta_min_ratio"]),
                )
            if delta_min > 0.0:
                if self._init_torso_z_m is None:
                    return fail()
                dz = sample.torso_z_m - self._init_torso_z_m
                if dz < delta_min:
                    return fail()
                reasons.append(f"Δz={dz:.3f}m ≥ {delta_min:.3f}")

        window_s = float(crit.get("window_s", self.task.max_episode_s))

        def inside_window() -> bool:
            return elapsed <= window_s + 0.5

        if "delta_x_m_min" in crit and self._init_x_m is not None:
            matched = True
            min_delta = float(crit["delta_x_m_min"])
            if sample.torso_x_m is None:
                return fail()
            dx = sample.torso_x_m - self._init_x_m
            if not (dx >= min_delta and inside_window()):
                return fail()
            reasons.append(f"Δx={dx:.3f}m ≥ {min_delta}")

        if "delta_x_m_max" in crit and self._init_x_m is not None:
            matched = True
            max_delta = float(crit["delta_x_m_max"])
            if sample.torso_x_m is None:
                return fail()
            dx = sample.torso_x_m - self._init_x_m
            if not (dx <= max_delta and inside_window()):
                return fail()
            reasons.append(f"Δx={dx:.3f}m ≤ {max_delta}")

        if "delta_y_m_min" in crit and self._init_y_m is not None:
            matched = True
            if sample.torso_y_m is None:
                return fail()
            dy = sample.torso_y_m - self._init_y_m
            min_delta = float(crit["delta_y_m_min"])
            if not (dy >= min_delta and inside_window()):
                return fail()
            reasons.append(f"Δy={dy:.3f}m ≥ {min_delta}")

        if "delta_y_m_max" in crit and self._init_y_m is not None:
            matched = True
            if sample.torso_y_m is None:
                return fail()
            dy = sample.torso_y_m - self._init_y_m
            max_delta = float(crit["delta_y_m_max"])
            if not (dy <= max_delta and inside_window()):
                return fail()
            reasons.append(f"Δy={dy:.3f}m ≤ {max_delta}")

        if "max_abs_delta_x_m" in crit and self._init_x_m is not None:
            matched = True
            if sample.torso_x_m is None:
                return fail()
            dx = sample.torso_x_m - self._init_x_m
            limit = float(crit["max_abs_delta_x_m"])
            if abs(dx) > limit:
                return fail()
            reasons.append(f"|Δx|={abs(dx):.3f}m ≤ {limit}")

        if "max_abs_delta_y_m" in crit and self._init_y_m is not None:
            matched = True
            if sample.torso_y_m is None:
                return fail()
            dy = sample.torso_y_m - self._init_y_m
            limit = float(crit["max_abs_delta_y_m"])
            if abs(dy) > limit:
                return fail()
            reasons.append(f"|Δy|={abs(dy):.3f}m ≤ {limit}")

        if "max_lateral_drift_m" in crit and self._init_y_m is not None:
            matched = True
            if sample.torso_y_m is None:
                return fail()
            dy = sample.torso_y_m - self._init_y_m
            limit = float(crit["max_lateral_drift_m"])
            if abs(dy) > limit:
                return fail()
            reasons.append(f"|Δy|={abs(dy):.3f}m ≤ {limit}")

        if "max_forward_drift_m" in crit and self._init_x_m is not None:
            matched = True
            if sample.torso_x_m is None:
                return fail()
            dx = sample.torso_x_m - self._init_x_m
            limit = float(crit["max_forward_drift_m"])
            if abs(dx) > limit:
                return fail()
            reasons.append(f"|Δx|={abs(dx):.3f}m ≤ {limit}")

        if (
            "max_translation_drift_m" in crit
            and self._init_x_m is not None
            and self._init_y_m is not None
        ):
            matched = True
            if sample.torso_x_m is None or sample.torso_y_m is None:
                return fail()
            dx = sample.torso_x_m - self._init_x_m
            dy = sample.torso_y_m - self._init_y_m
            drift = math.hypot(dx, dy)
            limit = float(crit["max_translation_drift_m"])
            if drift > limit:
                return fail()
            reasons.append(f"xy_drift={drift:.3f}m ≤ {limit}")

        if "delta_yaw_rad_min" in crit and self._init_yaw_rad is not None:
            matched = True
            if sample.yaw_rad is None:
                return fail()
            dyaw = _wrap_pi(sample.yaw_rad - self._init_yaw_rad)
            if not (dyaw >= float(crit["delta_yaw_rad_min"]) and inside_window()):
                return fail()
            reasons.append(f"Δyaw={math.degrees(dyaw):.1f}°")

        if "delta_yaw_rad_max" in crit and self._init_yaw_rad is not None:
            matched = True
            if sample.yaw_rad is None:
                return fail()
            dyaw = _wrap_pi(sample.yaw_rad - self._init_yaw_rad)
            if not (dyaw <= float(crit["delta_yaw_rad_max"]) and inside_window()):
                return fail()
            reasons.append(f"Δyaw={math.degrees(dyaw):.1f}°")

        if "abs_delta_yaw_rad_min" in crit and self._init_yaw_rad is not None:
            matched = True
            if sample.yaw_rad is None:
                return fail()
            adyaw = abs(_wrap_pi(sample.yaw_rad - self._init_yaw_rad))
            if not (adyaw >= float(crit["abs_delta_yaw_rad_min"]) and inside_window()):
                return fail()
            reasons.append(f"|Δyaw|={math.degrees(adyaw):.1f}°")

        if "max_abs_delta_yaw_rad" in crit and self._init_yaw_rad is not None:
            matched = True
            if sample.yaw_rad is None:
                return fail()
            adyaw = abs(_wrap_pi(sample.yaw_rad - self._init_yaw_rad))
            limit = float(crit["max_abs_delta_yaw_rad"])
            if adyaw > limit:
                return fail()
            reasons.append(
                f"|Δyaw|={math.degrees(adyaw):.1f}° "
                f"≤ {math.degrees(limit):.1f}°"
            )

        if "head_tilt_min_rad" in crit:
            matched = True
            if sample.head_tilt_rad < float(crit["head_tilt_min_rad"]):
                return fail()
            reasons.append(f"head_tilt={sample.head_tilt_rad:.2f}")

        if "head_tilt_max_rad" in crit:
            matched = True
            if sample.head_tilt_rad > float(crit["head_tilt_max_rad"]):
                return fail()
            reasons.append(f"head_tilt={sample.head_tilt_rad:.2f}")

        if "distance_to_target_m_max" in crit:
            matched = True
            if sample.target_distance_m is None:
                return fail()
            if sample.target_distance_m > float(crit["distance_to_target_m_max"]):
                return fail()
            reasons.append(f"dist={sample.target_distance_m:.3f}m")

        if "gripper_separation_max_m" in crit:
            matched = True
            if sample.gripper_separation_m is None:
                return fail()
            if sample.gripper_separation_m > float(crit["gripper_separation_max_m"]):
                return fail()
            reasons.append(f"gripper_sep={sample.gripper_separation_m:.3f}m")

        # Arm-oscillation detector for wave_left / wave_right tasks.
        for prefix, jname in (("l_sho_pitch_oscillation", "l_sho_pitch"),
                              ("r_sho_pitch_oscillation", "r_sho_pitch")):
            if crit.get(prefix):
                matched = True
                cycles = self._count_oscillation_cycles(jname)
                if cycles < int(crit.get("cycles_min", 1)):
                    return fail()
                reasons.append(f"{jname} cycles={cycles}")

        if "squat_cycles_min" in crit:
            matched = True
            # Detect torso_z oscillation around the initial standing height.
            cycles = self._count_torso_z_cycles()
            if cycles < int(crit["squat_cycles_min"]):
                return fail()
            reasons.append(f"squat cycles={cycles}")

        if "pushup_count_min" in crit:
            matched = True
            cycles = self._count_torso_z_cycles(min_amplitude=0.04)
            if cycles < int(crit["pushup_count_min"]):
                return fail()
            reasons.append(f"pushup cycles={cycles}")

        # If nothing matched, treat as "always fail" so the task spec has
        # to be explicit. Tighter than failing silently.
        if not matched:
            return False, hold, "no matching predicate"
        return True, hold, "; ".join(reasons)

    # ------------------------------------------------------------------
    def _count_oscillation_cycles(self, joint: str, min_amplitude: float = 0.6) -> int:
        hist = self._joint_history.get(joint)
        if not hist or len(hist) < 5:
            return 0
        # Zero-cross counter on (value - mean).
        mean = sum(hist) / len(hist)
        crossings = 0
        last_sign = 0
        for v in hist:
            d = v - mean
            sign = 1 if d > min_amplitude / 4 else (-1 if d < -min_amplitude / 4 else 0)
            if sign != 0 and sign != last_sign and last_sign != 0:
                crossings += 1
            if sign != 0:
                last_sign = sign
        return crossings // 2

    def _count_torso_z_cycles(self, min_amplitude: float = 0.06) -> int:
        zs = [s.torso_z_m for s in self.samples if s.torso_z_m is not None]
        if len(zs) < 5:
            return 0
        mean = sum(zs) / len(zs)
        crossings = 0
        last_sign = 0
        for z in zs:
            d = z - mean
            sign = 1 if d > min_amplitude / 4 else (-1 if d < -min_amplitude / 4 else 0)
            if sign != 0 and sign != last_sign and last_sign != 0:
                crossings += 1
            if sign != 0:
                last_sign = sign
        return crossings // 2


def _wrap_pi(angle: float) -> float:
    """Wrap to [-π, π]."""
    return math.atan2(math.sin(angle), math.cos(angle))
